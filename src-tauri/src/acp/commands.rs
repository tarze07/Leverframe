//! Tauri commands for ACP sessions. Events stream to the UI over a `Channel`.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;

use super::fs::{ContainerFs, FsKind};
use super::{launch_for, AcpEvent, AcpEvents, AcpService};
use crate::agents::AgentService;
use crate::profiles::{Profile, ProfileKind, ProfileService};
use crate::sessions::{AcpTranscript, ConversationInfo, SessionService};
use crate::settings::SettingsStore;

/// Events to the UI, recorded in the conversation's transcript on the way.
struct ChannelEvents {
    channel: Channel<AcpEvent>,
    transcript: Option<Arc<AcpTranscript>>,
}

impl AcpEvents for ChannelEvents {
    fn emit(&self, event: AcpEvent) {
        if let Some(t) = &self.transcript {
            if let Ok(value) = serde_json::to_value(&event) {
                t.event(value);
            }
            if let AcpEvent::Exited { code, .. } = &event {
                t.finish(code.map(i64::from));
            }
        }
        let _ = self.channel.send(event);
    }
}

/// A conversation to continue: the agent's session id, and the row in the history whose
/// transcript continues (none for a session picked from the agent's own list).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeRequest {
    pub session_id: String,
    pub history_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStartRequest {
    /// Agent from the catalog; its `acp` definition gives the command.
    pub agent_id: Option<String>,
    /// Explicit program and arguments in ACP mode (instead of `agent_id`), e.g. `["gemini", "--acp"]`.
    pub command: Option<Vec<String>>,
    /// Terminal profile to run it in (`None` = the default profile).
    pub profile_id: Option<String>,
    /// Project folder on this machine (local and WSL profiles).
    pub cwd: Option<PathBuf>,
    /// Continue a saved conversation instead of starting a new one.
    #[serde(default)]
    pub resume: Option<ResumeRequest>,
}

/// File access offered to the agent: its own machine or a WSL distribution; none on SSH hosts
/// (their files are not on this machine – the agent uses its own).
fn fs_kind(profile: Option<&Profile>) -> Option<FsKind> {
    match profile.map(|p| p.kind) {
        Some(ProfileKind::Ssh) => None,
        Some(ProfileKind::Wsl) => {
            let p = profile.expect("a WSL profile");
            let from_args = p
                .args
                .iter()
                .position(|a| a == "-d" || a == "--distribution")
                .and_then(|i| p.args.get(i + 1))
                .cloned();
            let distro = from_args.or_else(|| p.id.strip_prefix("wsl:").map(String::from))?;
            Some(FsKind::Wsl(distro))
        }
        _ => Some(FsKind::Local),
    }
}

/// The working directory of a conversation in a container (the project folder when a bind mount
/// holds it, else the profile's) and its file access: through the bind mount on this machine when
/// the directory is mounted, otherwise none (the agent uses its own files and commands, as on an
/// SSH host). The container must run – the UI starts it first.
async fn container_session(
    settings: &SettingsStore,
    profile: &Profile,
    local_cwd: Option<PathBuf>,
) -> Result<(String, Option<FsKind>), String> {
    let target = profile
        .container
        .clone()
        .ok_or_else(|| format!("{} nie jest profilem kontenera", profile.name))?;
    let docker = crate::docker::commands::for_profile(settings, profile);
    let program = profile.launch_spec().program;
    let details = blocking(move || {
        docker.inspect(&target.name).map_err(|e| match e {
            crate::docker::DockerError::NoSuchObject(_) => {
                format!("Kontenera {} już nie ma", target.name)
            }
            e => e.to_string(),
        })
    })
    .await?;
    if !details.running {
        return Err(format!(
            "Kontener {} jest zatrzymany – uruchom go i spróbuj ponownie",
            details.name
        ));
    }
    let target = profile.container.as_ref().expect("checked above");
    Ok(container_fs(
        target,
        program,
        &details.mounts,
        local_cwd.as_deref(),
    ))
}

/// See [`container_session`]; without Docker, for tests.
pub(crate) fn container_fs(
    target: &crate::profiles::ContainerTarget,
    program: String,
    mounts: &[crate::docker::ContainerMount],
    local_cwd: Option<&std::path::Path>,
) -> (String, Option<FsKind>) {
    use crate::docker::terminal::{container_dir, host_path};
    // On an SSH host the mounts are that host's folders: the agent keeps its own files and
    // commands (as on an SSH profile), in the profile's directory.
    if target.host.is_some() {
        let workdir = target
            .workdir
            .clone()
            .unwrap_or_else(|| crate::docker::actions::WORKSPACE.into());
        return (workdir, None);
    }
    let workdir = local_cwd
        .and_then(|d| container_dir(mounts, d))
        .or_else(|| target.workdir.clone())
        .unwrap_or_else(|| crate::docker::actions::WORKSPACE.into());
    let fs = host_path(mounts, &workdir).map(|_| {
        FsKind::Container(ContainerFs {
            program,
            name: target.name.clone(),
            user: target.user.clone(),
            mounts: mounts.to_vec(),
        })
    });
    (workdir, fs)
}

/// The command with the agent's variables: `env NAME=value … program` (POSIX scripts on this
/// machine, in WSL, on SSH hosts and in containers), or variables of the process (`windows_local`:
/// cmd.exe starts the agent).
fn with_agent_env(
    command: Vec<String>,
    env: &std::collections::BTreeMap<String, String>,
    windows_local: bool,
) -> (Vec<String>, Vec<(String, String)>) {
    if env.is_empty() {
        return (command, Vec::new());
    }
    if windows_local {
        return (
            command,
            env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        );
    }
    let mut line = vec!["env".to_string()];
    line.extend(env.iter().map(|(k, v)| format!("{k}={v}")));
    line.extend(command);
    (line, Vec::new())
}

/// The ACP command line: the explicit command, or the agent's `acp` definition.
fn resolve_command(
    request: &AcpStartRequest,
    agents: &AgentService,
) -> Result<Vec<String>, String> {
    let command = match (&request.agent_id, &request.command) {
        (_, Some(command)) => command.clone(),
        (Some(id), None) => {
            let agent = agents
                .find(id)
                .ok_or_else(|| format!("Agent „{id}” nie istnieje"))?;
            agent
                .acp
                .ok_or_else(|| format!("{} nie ma trybu rozmowy (ACP)", agent.name))?
                .command_line()
        }
        (None, None) => Vec::new(),
    };
    if command.first().map_or(true, |p| p.trim().is_empty()) {
        return Err("Brak komendy agenta".into());
    }
    Ok(command)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Starts an agent in ACP mode; returns the session id. Progress (handshake, login, errors)
/// arrives as events.
#[tauri::command]
pub async fn acp_start(
    service: State<'_, AcpService>,
    profiles: State<'_, ProfileService>,
    agents: State<'_, AgentService>,
    settings: State<'_, SettingsStore>,
    sessions: State<'_, SessionService>,
    request: AcpStartRequest,
    on_event: Channel<AcpEvent>,
) -> Result<u64, String> {
    let command = resolve_command(&request, &agents)?;
    let profile = match &request.profile_id {
        Some(id) => Some(
            profiles
                .resolve(id)
                .ok_or_else(|| format!("Profil „{id}” nie istnieje"))?,
        ),
        None => profiles.default_profile(),
    };
    let local_cwd = request.cwd.clone().or_else(crate::pty::home_dir);
    let container = match profile
        .as_ref()
        .filter(|p| p.kind == ProfileKind::Container)
    {
        Some(p) => Some(container_session(&settings, p, local_cwd.clone()).await?),
        None => None,
    };
    let remote_dir = match &container {
        Some((workdir, _)) => Some(workdir.clone()),
        None => profile
            .as_ref()
            .filter(|p| p.kind == ProfileKind::Ssh)
            .and_then(|p| crate::settings::remote_dir(&settings, &p.id)),
    };
    // The agent's variables from its settings: `env` before the program wherever a POSIX script
    // starts it, the process environment for cmd.exe on Windows.
    let agent_env = request
        .agent_id
        .as_deref()
        .and_then(|id| agents.find(id))
        .map(|a| a.env)
        .unwrap_or_default();
    let windows_local = cfg!(windows)
        && !matches!(
            profile.as_ref().map(|p| p.kind),
            Some(ProfileKind::Wsl | ProfileKind::Ssh | ProfileKind::Container)
        );
    let (command, process_env) = with_agent_env(command, &agent_env, windows_local);
    let mut launch = launch_for(
        profile.as_ref(),
        &command,
        local_cwd.as_deref(),
        remote_dir.as_deref(),
        cfg!(windows),
    );
    launch.env.extend(process_env);
    let fs = match container {
        Some((_, fs)) => fs,
        None => fs_kind(profile.as_ref()),
    };
    let transcript = match request.resume.as_ref().and_then(|r| r.history_id) {
        Some(history_id) => sessions.resume_conversation(history_id)?,
        None => sessions.start_conversation(&ConversationInfo {
            agent_id: request.agent_id.clone(),
            agent_name: request
                .agent_id
                .as_deref()
                .and_then(|id| agents.find(id))
                .map(|a| a.name),
            profile_id: profile.as_ref().map(|p| p.id.clone()),
            profile_name: profile.as_ref().map(|p| p.name.clone()),
            cwd: local_cwd.as_ref().map(|d| d.to_string_lossy().into_owned()),
        }),
    };
    let events = ChannelEvents {
        channel: on_event,
        transcript: transcript.clone(),
    };
    let resume = request.resume.map(|r| r.session_id);
    let id = match service.start(&launch, Arc::new(events), fs, resume) {
        Ok(id) => id,
        Err(e) => {
            if let Some(t) = transcript {
                t.finish(None);
            }
            return Err(e);
        }
    };
    if let Some(t) = transcript {
        service.set_transcript(id, t);
    }
    Ok(id)
}

/// Sends a text prompt; resolves with the stop reason when the turn ends.
#[tauri::command]
pub async fn acp_prompt(
    service: State<'_, AcpService>,
    id: u64,
    text: String,
) -> Result<String, String> {
    let session = service.get(id)?;
    let transcript = service.transcript(id);
    blocking(move || {
        if let Some(t) = &transcript {
            t.sent(&text);
        }
        let result = session.prompt(&text);
        if let (Some(t), Ok(reason)) = (&transcript, &result) {
            t.turn_ended(reason);
        }
        result
    })
    .await
}

/// The agent's saved sessions in this folder (`session/list`): `{ sessions, nextCursor }`.
#[tauri::command]
pub async fn acp_list_sessions(
    service: State<'_, AcpService>,
    id: u64,
    cursor: Option<String>,
) -> Result<serde_json::Value, String> {
    let session = service.get(id)?;
    blocking(move || session.list_sessions(cursor.as_deref())).await
}

/// Opens one of the agent's saved sessions in this panel; the agent replays it.
#[tauri::command]
pub async fn acp_load_session(
    service: State<'_, AcpService>,
    id: u64,
    session_id: String,
) -> Result<(), String> {
    let session = service.get(id)?;
    if let Some(t) = service.transcript(id) {
        t.reset();
    }
    blocking(move || session.load_session(&session_id)).await
}

/// Deletes a saved session at the agent (`session/delete`); only on the user's explicit request.
#[tauri::command]
pub async fn acp_delete_session(
    service: State<'_, AcpService>,
    id: u64,
    session_id: String,
) -> Result<(), String> {
    let session = service.get(id)?;
    blocking(move || session.delete_session(&session_id)).await
}

#[tauri::command]
pub fn acp_cancel(service: State<'_, AcpService>, id: u64) -> Result<(), String> {
    service.get(id)?.cancel()
}

/// Answers a permission request: an option id from the request, or `null` to refuse.
#[tauri::command]
pub fn acp_permission_reply(
    service: State<'_, AcpService>,
    id: u64,
    request_id: u64,
    option_id: Option<String>,
) -> Result<(), String> {
    service
        .get(id)?
        .reply_permission(request_id, option_id.as_deref())
}

#[tauri::command]
pub async fn acp_set_mode(
    service: State<'_, AcpService>,
    id: u64,
    mode_id: String,
) -> Result<(), String> {
    let session = service.get(id)?;
    blocking(move || session.set_mode(&mode_id)).await
}

/// `value`: the option's value id (select) or `true` / `false` (boolean).
#[tauri::command]
pub async fn acp_set_config_option(
    service: State<'_, AcpService>,
    id: u64,
    config_id: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let session = service.get(id)?;
    blocking(move || session.set_config_option(&config_id, value)).await
}

/// Answers a file request: `content` for a read, nothing for a write, or `error`.
#[tauri::command]
pub fn acp_fs_reply(
    service: State<'_, AcpService>,
    id: u64,
    request_id: u64,
    content: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    let result = match error {
        Some(e) => Err(e),
        None => Ok(content),
    };
    service.get(id)?.reply_fs(request_id, result)
}

/// Answers a command request of the agent: run it or not.
#[tauri::command]
pub fn acp_terminal_reply(
    service: State<'_, AcpService>,
    id: u64,
    request_id: u64,
    allow: bool,
) -> Result<(), String> {
    service.get(id)?.reply_terminal(request_id, allow)
}

#[tauri::command]
pub async fn acp_authenticate(
    service: State<'_, AcpService>,
    id: u64,
    method_id: String,
) -> Result<(), String> {
    let session = service.get(id)?;
    blocking(move || session.authenticate(&method_id)).await
}

#[tauri::command]
pub fn acp_stop(service: State<'_, AcpService>, id: u64) {
    service.stop(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(agent_id: Option<&str>, command: Option<&[&str]>) -> AcpStartRequest {
        AcpStartRequest {
            agent_id: agent_id.map(String::from),
            command: command.map(|c| c.iter().map(|s| s.to_string()).collect()),
            profile_id: None,
            cwd: None,
            resume: None,
        }
    }

    #[test]
    fn file_access_depends_on_the_profile() {
        use crate::profiles::ProfileSource;
        let profile = |id: &str, kind: ProfileKind, args: &[&str]| Profile {
            id: id.into(),
            name: id.into(),
            kind,
            command: "x".into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: Default::default(),
            cwd: None,
            icon: None,
            description: None,
            ssh: None,
            container: None,
            source: ProfileSource::Detected,
        };
        assert_eq!(fs_kind(None), Some(FsKind::Local));
        assert_eq!(
            fs_kind(Some(&profile("local:bash", ProfileKind::Local, &[]))),
            Some(FsKind::Local)
        );
        assert_eq!(
            fs_kind(Some(&profile("pwsh", ProfileKind::Powershell, &[]))),
            Some(FsKind::Local)
        );
        assert_eq!(
            fs_kind(Some(&profile("srv", ProfileKind::Ssh, &[]))),
            None,
            "files on the host stay there"
        );
        assert_eq!(
            fs_kind(Some(&profile(
                "wsl:Debian",
                ProfileKind::Wsl,
                &["-d", "Ubuntu-24.04"]
            ))),
            Some(FsKind::Wsl("Ubuntu-24.04".into()))
        );
        assert_eq!(
            fs_kind(Some(&profile("wsl:Debian", ProfileKind::Wsl, &[]))),
            Some(FsKind::Wsl("Debian".into()))
        );
    }

    #[test]
    fn the_command_comes_from_the_agent_or_the_request() {
        let agents = AgentService::new(&std::env::temp_dir().join("lf-acp-cmd-none"));
        assert_eq!(
            resolve_command(&request(Some("gemini"), None), &agents).unwrap(),
            ["gemini", "--acp"]
        );
        assert_eq!(
            resolve_command(&request(Some("claude"), None), &agents).unwrap(),
            ["claude-agent-acp"]
        );
        assert_eq!(
            resolve_command(&request(Some("gemini"), Some(&["fake", "-x"])), &agents).unwrap(),
            ["fake", "-x"],
            "an explicit command wins (tests, custom setups)"
        );
        assert!(resolve_command(&request(Some("agy"), None), &agents)
            .unwrap_err()
            .contains("nie ma trybu rozmowy"));
        assert!(resolve_command(&request(Some("nope"), None), &agents).is_err());
        assert!(resolve_command(&request(None, None), &agents).is_err());
        assert!(resolve_command(&request(None, Some(&[" "])), &agents).is_err());
    }

    #[test]
    fn container_conversations_use_the_mounted_project_folder() {
        let target = crate::profiles::ContainerTarget {
            name: "sklep".into(),
            ..Default::default()
        };
        let mounts = vec![
            crate::docker::ContainerMount {
                kind: "bind".into(),
                source: "/home/me/sklep".into(),
                destination: "/workspace".into(),
                name: None,
                read_write: true,
            },
            crate::docker::ContainerMount {
                kind: "volume".into(),
                source: "/var/lib/docker/volumes/h/_data".into(),
                destination: "/root".into(),
                name: None,
                read_write: true,
            },
        ];
        let (dir, fs) = container_fs(
            &target,
            "docker".into(),
            &mounts,
            Some(std::path::Path::new("/home/me/sklep/api")),
        );
        assert_eq!(dir, "/workspace/api");
        assert!(
            matches!(fs, Some(FsKind::Container(c)) if c.name == "sklep" && c.mounts.len() == 2)
        );
        // The project is not in the container: the profile's folder (mounted here).
        let (dir, fs) = container_fs(
            &target,
            "docker".into(),
            &mounts,
            Some(std::path::Path::new("/home/me/inny")),
        );
        assert_eq!(dir, "/workspace");
        assert!(fs.is_some());
        // A folder only in the container: its own files and commands, as on an SSH host.
        let in_volume = crate::profiles::ContainerTarget {
            workdir: Some("/root/projekt".into()),
            ..target
        };
        let (dir, fs) = container_fs(&in_volume, "docker".into(), &mounts, None);
        assert_eq!((dir.as_str(), fs), ("/root/projekt", None));
    }

    #[test]
    fn the_agents_variables_reach_the_conversation_mode() {
        let env: std::collections::BTreeMap<String, String> = [(
            "OPENCODE_CONFIG".to_string(),
            "/home/me/a b.json".to_string(),
        )]
        .into();
        let cmd = vec!["opencode".to_string(), "acp".to_string()];
        assert_eq!(
            with_agent_env(cmd.clone(), &env, false),
            (
                [
                    "env",
                    "OPENCODE_CONFIG=/home/me/a b.json",
                    "opencode",
                    "acp"
                ]
                .map(String::from)
                .to_vec(),
                vec![]
            )
        );
        assert_eq!(
            with_agent_env(cmd.clone(), &env, true),
            (
                cmd.clone(),
                vec![("OPENCODE_CONFIG".into(), "/home/me/a b.json".into())]
            )
        );
        assert_eq!(
            with_agent_env(cmd.clone(), &Default::default(), false),
            (cmd, vec![])
        );
    }

    #[test]
    fn a_container_on_an_ssh_host_keeps_its_own_files() {
        let target = crate::profiles::ContainerTarget {
            name: "sklep".into(),
            host: Some("ssh:gpu".into()),
            ..Default::default()
        };
        let mounts = vec![crate::docker::ContainerMount {
            kind: "bind".into(),
            source: "/home/me/sklep".into(),
            destination: "/workspace".into(),
            name: None,
            read_write: true,
        }];
        // Even a folder of this machine with the same path is not the host's folder.
        let (dir, fs) = container_fs(
            &target,
            "docker".into(),
            &mounts,
            Some(std::path::Path::new("/home/me/sklep")),
        );
        assert_eq!((dir.as_str(), fs), ("/workspace", None));
    }
}
