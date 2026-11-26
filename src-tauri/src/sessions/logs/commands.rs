use std::sync::Arc;

use tauri::State;

use super::model::{LogDetail, LogSummary};
use super::service::AgentLogService;

/// Sources on another machine – `ssh:<profile id>` (an SSH host) and `docker:<profile id>`
/// (a container) – need their profile to run commands there.
async fn remote_profile(
    app: &tauri::AppHandle,
    source: &str,
) -> Result<Option<crate::profiles::Profile>, String> {
    let id = match source.split_once(':') {
        Some(("ssh" | "docker", id)) => id,
        _ => return Ok(None),
    };
    crate::profiles::commands::resolve(app, id).await.map(Some)
}

/// Conversations from the agents' own logs in a source (`local`, `wsl:<distro>`, `ssh:<profile>`
/// or `docker:<profile>`).
#[tauri::command]
pub async fn agent_logs_list(
    app: tauri::AppHandle,
    logs: State<'_, Arc<AgentLogService>>,
    source: String,
) -> Result<Vec<LogSummary>, String> {
    let svc = logs.inner().clone();
    let profile = remote_profile(&app, &source).await?;
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
    app: tauri::AppHandle,
    logs: State<'_, Arc<AgentLogService>>,
    source: String,
    path: String,
) -> Result<LogDetail, String> {
    let svc = logs.inner().clone();
    let profile = remote_profile(&app, &source).await?;
    tauri::async_runtime::spawn_blocking(move || match profile {
        Some(p) => svc.ssh.read(&p, &source, &path),
        None => svc.read(&source, &path),
    })
    .await
    .map_err(|e| e.to_string())?
}
