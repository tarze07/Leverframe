//! Tauri commands for the frontend. Output is streamed over a `Channel` as raw bytes
//! (ArrayBuffer on the JS side), which avoids JSON/base64 overhead and UTF-8 splitting issues.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use super::manager::{
    PtyEvents, PtyId, PtyInfo, PtyManager, SessionMeta, SpawnOptions, SpawnedPty,
};
use crate::agents::AgentService;
use crate::profiles::{Profile, ProfileKind, ProfileService};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub exit_code: Option<u32>,
}

struct ChannelEvents {
    data: Channel<InvokeResponseBody>,
    exit: Channel<PtyExit>,
}

impl PtyEvents for ChannelEvents {
    fn data(&self, bytes: Vec<u8>) {
        let _ = self.data.send(InvokeResponseBody::Raw(bytes));
    }
    fn exit(&self, code: Option<u32>) {
        let _ = self.exit.send(PtyExit { exit_code: code });
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnRequest {
    /// Terminal profile to start (takes precedence over `program`/`args`).
    pub profile_id: Option<String>,
    /// Agent to start in the terminal (its command is typed into the shell by the UI).
    pub agent_id: Option<String>,
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnResponse {
    #[serde(flatten)]
    pub pty: SpawnedPty,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub agent_id: Option<String>,
    /// Command line the UI should type once the shell is ready (`claude`, `kilo`, …).
    pub agent_command: Option<String>,
}

/// Result of resolving a spawn request.
pub struct Resolved {
    pub opts: SpawnOptions,
    pub profile: Option<Profile>,
    pub agent_command: Option<String>,
}

/// `wsl.exe --cd <dir>` decides the working directory inside WSL (the PTY's cwd does not).
/// Windows paths are accepted by `--cd` and translated by WSL itself.
fn wsl_with_cwd(args: Vec<String>, cwd: &str) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len() + 2);
    let mut it = args.into_iter();
    let mut replaced = false;
    while let Some(a) = it.next() {
        if a == "--cd" {
            it.next();
            out.extend(["--cd".to_string(), cwd.to_string()]);
            replaced = true;
        } else {
            out.push(a);
        }
    }
    if !replaced {
        out.extend(["--cd".to_string(), cwd.to_string()]);
    }
    out
}

/// Turns a request into spawn options: an explicit profile, an explicit program,
/// or – when neither is given – the default profile (falling back to the default shell).
/// With `agent_id`, the agent's command is resolved and the session is marked as an agent session.
pub fn resolve_request(
    request: PtySpawnRequest,
    profiles: &ProfileService,
    agents: &AgentService,
) -> Result<Resolved, String> {
    let profile = match (&request.profile_id, &request.program) {
        (Some(id), _) => Some(
            profiles
                .resolve(id)
                .ok_or_else(|| format!("Profil „{id}” nie istnieje"))?,
        ),
        (None, None) => profiles.default_profile(),
        (None, Some(_)) => None,
    };
    let agent = match &request.agent_id {
        Some(id) => Some(
            agents
                .find(id)
                .ok_or_else(|| format!("Agent „{id}” nie istnieje"))?,
        ),
        None => None,
    };
    let cwd_text = request
        .cwd
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    let mut opts = SpawnOptions {
        program: request.program,
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        cols: request.cols,
        rows: request.rows,
        meta: SessionMeta {
            profile_id: profile.as_ref().map(|p| p.id.clone()),
            agent_id: agent.as_ref().map(|a| a.id.clone()),
            cwd: cwd_text.clone(),
            started_at: 0,
        },
    };
    if let Some(profile) = &profile {
        let spec = profile.launch_spec();
        opts.program = Some(spec.program);
        opts.args = spec.args;
        let mut env = spec.env;
        env.extend(opts.env);
        opts.env = env;
        if opts.cwd.is_none() {
            opts.cwd = spec.cwd.map(PathBuf::from);
        }
        if profile.kind == ProfileKind::Wsl {
            if let Some(dir) = &cwd_text {
                opts.args = wsl_with_cwd(opts.args, dir);
            }
        }
    }
    let agent_command =
        agent.map(|a| agents.command_for(&a, profile.as_ref().map(|p| p.id.as_str())));
    Ok(Resolved {
        opts,
        profile,
        agent_command,
    })
}

#[tauri::command]
pub fn pty_spawn(
    manager: State<'_, PtyManager>,
    profiles: State<'_, ProfileService>,
    agents: State<'_, AgentService>,
    request: PtySpawnRequest,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<PtyExit>,
) -> Result<PtySpawnResponse, String> {
    let Resolved {
        opts,
        profile,
        agent_command,
    } = resolve_request(request, &profiles, &agents)?;
    let agent_id = opts.meta.agent_id.clone();
    let pty = manager.spawn(
        opts,
        Arc::new(ChannelEvents {
            data: on_data,
            exit: on_exit,
        }),
    )?;
    Ok(PtySpawnResponse {
        pty,
        profile_id: profile.as_ref().map(|p| p.id.clone()),
        profile_name: profile.map(|p| p.name),
        agent_id,
        agent_command,
    })
}

/// Running terminals with their metadata (profile, agent, working directory, start time).
#[tauri::command]
pub fn pty_list(manager: State<'_, PtyManager>) -> Vec<PtyInfo> {
    manager.list()
}

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, id: PtyId, data: String) -> Result<(), String> {
    manager.write(id, data.as_bytes())
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: PtyId,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: PtyId) -> Result<(), String> {
    manager.kill(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{ProfileKind, ProfileSource};
    use std::collections::BTreeMap;

    fn service() -> ProfileService {
        let dir = std::env::temp_dir().join(format!("lf-pty-req-{}", std::process::id()));
        ProfileService::with_detector(&dir, || {
            vec![Profile {
                id: "local:zsh".into(),
                name: "zsh".into(),
                kind: ProfileKind::Local,
                command: "/bin/zsh".into(),
                args: vec!["-l".into()],
                env: BTreeMap::from([("A".into(), "1".into())]),
                cwd: Some("/tmp".into()),
                icon: None,
                description: None,
                ssh: None,
                source: ProfileSource::Detected,
            }]
        })
    }

    fn agents() -> AgentService {
        AgentService::new(&std::env::temp_dir().join("lf-pty-req-agents-none"))
    }

    fn resolve(req: PtySpawnRequest) -> Result<(SpawnOptions, Option<Profile>), String> {
        resolve_request(req, &service(), &agents()).map(|r| (r.opts, r.profile))
    }

    fn request() -> PtySpawnRequest {
        PtySpawnRequest {
            cols: 80,
            rows: 24,
            ..Default::default()
        }
    }

    #[test]
    fn resolves_explicit_profile() {
        let (opts, profile) = resolve(PtySpawnRequest {
            profile_id: Some("local:zsh".into()),
            env: vec![("B".into(), "2".into())],
            ..request()
        })
        .unwrap();
        assert_eq!(profile.unwrap().name, "zsh");
        assert_eq!(opts.program.as_deref(), Some("/bin/zsh"));
        assert_eq!(opts.args, ["-l"]);
        assert_eq!(
            opts.env,
            [("A".into(), "1".into()), ("B".into(), "2".into())]
        );
        assert_eq!(opts.cwd, Some(PathBuf::from("/tmp")));
    }

    #[test]
    fn uses_default_profile_without_program() {
        let (opts, profile) = resolve(request()).unwrap();
        assert_eq!(profile.unwrap().id, "local:zsh");
        assert_eq!(opts.program.as_deref(), Some("/bin/zsh"));
    }

    #[test]
    fn explicit_program_bypasses_profiles() {
        let (opts, profile) = resolve(PtySpawnRequest {
            program: Some("/bin/sh".into()),
            ..request()
        })
        .unwrap();
        assert!(profile.is_none());
        assert_eq!(opts.program.as_deref(), Some("/bin/sh"));
    }

    #[test]
    fn unknown_profile_is_an_error() {
        let err = resolve(PtySpawnRequest {
            profile_id: Some("nope".into()),
            ..request()
        });
        assert!(err.is_err());
        let err = resolve(PtySpawnRequest {
            agent_id: Some("nope".into()),
            ..request()
        });
        assert!(err.is_err());
    }

    #[test]
    fn agent_requests_are_marked_and_return_the_command() {
        let r = resolve_request(
            PtySpawnRequest {
                profile_id: Some("local:zsh".into()),
                agent_id: Some("kilo".into()),
                cwd: Some("/work/project".into()),
                ..request()
            },
            &service(),
            &agents(),
        )
        .unwrap();
        assert_eq!(r.agent_command.as_deref(), Some("kilo"));
        assert_eq!(r.opts.meta.agent_id.as_deref(), Some("kilo"));
        assert_eq!(r.opts.meta.profile_id.as_deref(), Some("local:zsh"));
        assert_eq!(r.opts.meta.cwd.as_deref(), Some("/work/project"));
        assert_eq!(
            r.opts.cwd,
            Some(PathBuf::from("/work/project")),
            "explicit cwd wins over the profile's"
        );
    }

    #[test]
    fn wsl_working_directory_goes_through_cd() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            wsl_with_cwd(args(&["-d", "Ubuntu", "--cd", "~"]), r"C:\src\app"),
            args(&["-d", "Ubuntu", "--cd", r"C:\src\app"])
        );
        assert_eq!(
            wsl_with_cwd(args(&["-d", "Ubuntu"]), "/home/me"),
            args(&["-d", "Ubuntu", "--cd", "/home/me"])
        );
    }
}
