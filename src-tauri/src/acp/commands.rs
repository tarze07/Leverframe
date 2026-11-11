//! Tauri commands for ACP sessions. Events stream to the UI over a `Channel`.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;

use super::{launch_for, AcpEvent, AcpEvents, AcpService};
use crate::profiles::{ProfileKind, ProfileService};
use crate::settings::SettingsStore;

struct ChannelEvents(Channel<AcpEvent>);

impl AcpEvents for ChannelEvents {
    fn emit(&self, event: AcpEvent) {
        let _ = self.0.send(event);
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStartRequest {
    /// Agent program and arguments in ACP mode, e.g. `["gemini", "--acp"]`.
    pub command: Vec<String>,
    /// Terminal profile to run it in (`None` = the default profile).
    pub profile_id: Option<String>,
    /// Project folder on this machine (local and WSL profiles).
    pub cwd: Option<PathBuf>,
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
pub fn acp_start(
    service: State<'_, AcpService>,
    profiles: State<'_, ProfileService>,
    settings: State<'_, SettingsStore>,
    request: AcpStartRequest,
    on_event: Channel<AcpEvent>,
) -> Result<u64, String> {
    if request
        .command
        .first()
        .map_or(true, |p| p.trim().is_empty())
    {
        return Err("Brak komendy agenta".into());
    }
    let profile = match &request.profile_id {
        Some(id) => Some(
            profiles
                .resolve(id)
                .ok_or_else(|| format!("Profil „{id}” nie istnieje"))?,
        ),
        None => profiles.default_profile(),
    };
    let remote_dir = profile
        .as_ref()
        .filter(|p| p.kind == ProfileKind::Ssh)
        .and_then(|p| crate::settings::remote_dir(&settings, &p.id));
    let local_cwd = request.cwd.or_else(crate::pty::home_dir);
    let launch = launch_for(
        profile.as_ref(),
        &request.command,
        local_cwd.as_deref(),
        remote_dir.as_deref(),
        cfg!(windows),
    );
    service.start(&launch, Arc::new(ChannelEvents(on_event)))
}

/// Sends a text prompt; resolves with the stop reason when the turn ends.
#[tauri::command]
pub async fn acp_prompt(
    service: State<'_, AcpService>,
    id: u64,
    text: String,
) -> Result<String, String> {
    let session = service.get(id)?;
    blocking(move || session.prompt(&text)).await
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
