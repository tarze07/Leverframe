use std::sync::Arc;

use tauri::State;

use super::model::{LogDetail, LogSummary};
use super::service::AgentLogService;
use crate::profiles::ProfileService;

/// `ssh:<profile id>` sources need the SSH profile to connect.
fn ssh_profile(
    profiles: &ProfileService,
    source: &str,
) -> Result<Option<crate::profiles::Profile>, String> {
    match source.strip_prefix("ssh:") {
        Some(id) => profiles
            .resolve(id)
            .map(Some)
            .ok_or_else(|| format!("Profil SSH „{id}” nie istnieje")),
        None => Ok(None),
    }
}

/// Conversations from the agents' own logs in a source (`local`, `wsl:<distro>` or `ssh:<profile>`).
#[tauri::command]
pub async fn agent_logs_list(
    logs: State<'_, Arc<AgentLogService>>,
    profiles: State<'_, ProfileService>,
    source: String,
) -> Result<Vec<LogSummary>, String> {
    let svc = logs.inner().clone();
    let profile = ssh_profile(&profiles, &source)?;
    tauri::async_runtime::spawn_blocking(move || match profile {
        Some(p) => svc.ssh.list(&p, &source),
        None => svc.list(&source),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Timeline of one conversation.
#[tauri::command]
pub async fn agent_log_read(
    logs: State<'_, Arc<AgentLogService>>,
    profiles: State<'_, ProfileService>,
    source: String,
    path: String,
) -> Result<LogDetail, String> {
    let svc = logs.inner().clone();
    let profile = ssh_profile(&profiles, &source)?;
    tauri::async_runtime::spawn_blocking(move || match profile {
        Some(p) => svc.ssh.read(&p, &source, &path),
        None => svc.read(&source, &path),
    })
    .await
    .map_err(|e| e.to_string())?
}
