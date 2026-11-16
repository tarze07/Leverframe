//! Tauri commands for Docker (read only in D1). The program comes from the `dockerPath` setting.

use tauri::State;

use super::{ContainerDetails, Docker, DockerContainer, DockerImage, DockerInfo, DockerVolume};
use crate::settings::SettingsStore;

pub const DOCKER_PATH_KEY: &str = "dockerPath";

/// The CLI from the settings (`docker` when not set).
pub fn docker(settings: &SettingsStore) -> Docker {
    Docker::new(
        settings
            .get_value(DOCKER_PATH_KEY)
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default(),
    )
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Whether Docker is installed and running (never an error: the reason is in `message`).
#[tauri::command]
pub async fn docker_info(settings: State<'_, SettingsStore>) -> Result<DockerInfo, String> {
    let d = docker(&settings);
    blocking(move || Ok(d.info())).await
}

#[tauri::command]
pub async fn docker_images(settings: State<'_, SettingsStore>) -> Result<Vec<DockerImage>, String> {
    let d = docker(&settings);
    blocking(move || d.images().map_err(String::from)).await
}

#[tauri::command]
pub async fn docker_containers(
    settings: State<'_, SettingsStore>,
) -> Result<Vec<DockerContainer>, String> {
    let d = docker(&settings);
    blocking(move || d.containers().map_err(String::from)).await
}

#[tauri::command]
pub async fn docker_volumes(
    settings: State<'_, SettingsStore>,
) -> Result<Vec<DockerVolume>, String> {
    let d = docker(&settings);
    blocking(move || d.volumes().map_err(String::from)).await
}

#[tauri::command]
pub async fn docker_inspect(
    settings: State<'_, SettingsStore>,
    container: String,
) -> Result<ContainerDetails, String> {
    let d = docker(&settings);
    blocking(move || d.inspect(&container).map_err(String::from)).await
}
