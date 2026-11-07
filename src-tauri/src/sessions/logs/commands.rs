use tauri::State;

use super::model::{LogDetail, LogSummary};
use super::service::AgentLogService;
use std::sync::Arc;

/// Conversations from the agents' own logs in a source (`local` or `wsl:<distro>`).
#[tauri::command]
pub async fn agent_logs_list(
    logs: State<'_, Arc<AgentLogService>>,
    source: String,
) -> Result<Vec<LogSummary>, String> {
    let svc = logs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || svc.list(&source))
        .await
        .map_err(|e| e.to_string())?
}

/// Timeline of one conversation.
#[tauri::command]
pub async fn agent_log_read(
    logs: State<'_, Arc<AgentLogService>>,
    source: String,
    path: String,
) -> Result<LogDetail, String> {
    let svc = logs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || svc.read(&source, &path))
        .await
        .map_err(|e| e.to_string())?
}
