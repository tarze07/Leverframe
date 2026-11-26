//! Tauri commands. The work runs on a thread for blocking work: detection (`wsl.exe`, `docker`,
//! `ssh` to a host) may take seconds and must hold up neither the window nor the async runtime's
//! few threads, which other commands and events need (#115).

use tauri::{AppHandle, Manager};

use super::model::Profile;
use super::service::{ProfileService, ProfilesState};

/// Runs `f` with the profiles on a thread for blocking work.
pub async fn with_profiles<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&ProfileService) -> T + Send + 'static,
) -> Result<T, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<ProfileService>()))
        .await
        .map_err(|e| e.to_string())
}

/// A profile by id, found off the async runtime's threads.
pub async fn resolve(app: &AppHandle, id: &str) -> Result<Profile, String> {
    let id = id.to_string();
    with_profiles(app, move |p| {
        p.resolve(&id)
            .ok_or_else(|| format!("Profil „{id}” nie istnieje"))
    })
    .await?
}

#[tauri::command]
pub async fn profiles_list(app: AppHandle) -> Result<ProfilesState, String> {
    with_profiles(&app, |p| p.state()).await
}

#[tauri::command]
pub async fn profiles_refresh(app: AppHandle) -> Result<ProfilesState, String> {
    with_profiles(&app, |p| p.refresh()).await
}

#[tauri::command]
pub async fn profile_save(app: AppHandle, profile: Profile) -> Result<Profile, String> {
    with_profiles(&app, move |p| p.save(profile)).await?
}

#[tauri::command]
pub async fn profile_delete(app: AppHandle, id: String) -> Result<(), String> {
    with_profiles(&app, move |p| p.delete(&id)).await?
}

#[tauri::command]
pub async fn profile_set_default(app: AppHandle, id: String) -> Result<(), String> {
    with_profiles(&app, move |p| p.set_default(&id)).await?
}
