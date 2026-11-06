//! Tauri commands for the frontend. Output is streamed over a `Channel` as raw bytes
//! (ArrayBuffer on the JS side), which avoids JSON/base64 overhead and UTF-8 splitting issues.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use super::manager::{PtyEvents, PtyId, PtyManager, SpawnOptions, SpawnedPty};
use crate::profiles::{Profile, ProfileService};

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
}

/// Turns a request into spawn options: an explicit profile, an explicit program,
/// or – when neither is given – the default profile (falling back to the default shell).
pub fn resolve_request(
    request: PtySpawnRequest,
    profiles: &ProfileService,
) -> Result<(SpawnOptions, Option<Profile>), String> {
    let profile = match (&request.profile_id, &request.program) {
        (Some(id), _) => Some(
            profiles
                .resolve(id)
                .ok_or_else(|| format!("Profil „{id}” nie istnieje"))?,
        ),
        (None, None) => profiles.default_profile(),
        (None, Some(_)) => None,
    };
    let mut opts = SpawnOptions {
        program: request.program,
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        cols: request.cols,
        rows: request.rows,
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
    }
    Ok((opts, profile))
}

#[tauri::command]
pub fn pty_spawn(
    manager: State<'_, PtyManager>,
    profiles: State<'_, ProfileService>,
    request: PtySpawnRequest,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<PtyExit>,
) -> Result<PtySpawnResponse, String> {
    let (opts, profile) = resolve_request(request, &profiles)?;
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
    })
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

    fn request() -> PtySpawnRequest {
        PtySpawnRequest {
            cols: 80,
            rows: 24,
            ..Default::default()
        }
    }

    #[test]
    fn resolves_explicit_profile() {
        let (opts, profile) = resolve_request(
            PtySpawnRequest {
                profile_id: Some("local:zsh".into()),
                env: vec![("B".into(), "2".into())],
                ..request()
            },
            &service(),
        )
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
        let (opts, profile) = resolve_request(request(), &service()).unwrap();
        assert_eq!(profile.unwrap().id, "local:zsh");
        assert_eq!(opts.program.as_deref(), Some("/bin/zsh"));
    }

    #[test]
    fn explicit_program_bypasses_profiles() {
        let (opts, profile) = resolve_request(
            PtySpawnRequest {
                program: Some("/bin/sh".into()),
                ..request()
            },
            &service(),
        )
        .unwrap();
        assert!(profile.is_none());
        assert_eq!(opts.program.as_deref(), Some("/bin/sh"));
    }

    #[test]
    fn unknown_profile_is_an_error() {
        let err = resolve_request(
            PtySpawnRequest {
                profile_id: Some("nope".into()),
                ..request()
            },
            &service(),
        );
        assert!(err.is_err());
    }
}
