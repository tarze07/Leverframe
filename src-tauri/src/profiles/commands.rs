//! Tauri commands. Async so that detection (which may run `wsl.exe`) never blocks the UI thread.

use tauri::State;

use super::model::Profile;
use super::service::{ProfileService, ProfilesState};

type Service<'a> = State<'a, ProfileService>;

#[tauri::command]
pub async fn profiles_list(service: Service<'_>) -> Result<ProfilesState, String> {
    Ok(service.state())
}

#[tauri::command]
pub async fn profiles_refresh(service: Service<'_>) -> Result<ProfilesState, String> {
    Ok(service.refresh())
}

#[tauri::command]
pub async fn profile_save(service: Service<'_>, profile: Profile) -> Result<Profile, String> {
    service.save(profile)
}

#[tauri::command]
pub async fn profile_delete(service: Service<'_>, id: String) -> Result<(), String> {
    service.delete(&id)
}

#[tauri::command]
pub async fn profile_set_default(service: Service<'_>, id: String) -> Result<(), String> {
    service.set_default(&id)
}
