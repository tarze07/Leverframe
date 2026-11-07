use tauri::State;

use super::db::{Facets, SessionFilter, SessionRecord};
use super::service::{SessionService, SessionsInfo};

#[tauri::command]
pub async fn sessions_info(sessions: State<'_, SessionService>) -> Result<SessionsInfo, String> {
    Ok(sessions.info())
}

#[tauri::command]
pub async fn sessions_list(
    sessions: State<'_, SessionService>,
    filter: SessionFilter,
) -> Result<Vec<SessionRecord>, String> {
    sessions.list(&filter)
}

#[tauri::command]
pub async fn sessions_facets(sessions: State<'_, SessionService>) -> Result<Facets, String> {
    sessions.facets()
}

/// Contents of a recording (asciicast v2).
#[tauri::command]
pub async fn sessions_read(sessions: State<'_, SessionService>, id: i64) -> Result<String, String> {
    sessions.read(id)
}

#[tauri::command]
pub async fn sessions_delete(sessions: State<'_, SessionService>, id: i64) -> Result<(), String> {
    sessions.delete(id)
}

#[tauri::command]
pub async fn sessions_clear(sessions: State<'_, SessionService>) -> Result<usize, String> {
    sessions.clear()
}

#[tauri::command]
pub async fn sessions_set_recording(
    sessions: State<'_, SessionService>,
    enabled: bool,
) -> Result<(), String> {
    sessions.set_recording_enabled(enabled)
}
