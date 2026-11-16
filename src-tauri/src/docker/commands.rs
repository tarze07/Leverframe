//! Tauri commands for Docker. The program comes from the `dockerPath` setting. Changes are made
//! only on the user's request in the "Kontenery" view (removals after a confirmation there).

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use super::actions::plan;
use super::jobs::{build_args, logs_args, pull_args};
use super::terminal::PreparedContainer;
use super::{
    ContainerDetails, ContainerSpec, CreatePlan, Docker, DockerContainer, DockerImage, DockerInfo,
    DockerJobs, DockerVolume, JobEvent, JobEvents,
};
use crate::profiles::ProfileService;
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

/// What creating the container will do: `docker run` and warnings (shown before it runs).
#[tauri::command]
pub fn docker_create_plan(spec: ContainerSpec) -> Result<CreatePlan, String> {
    plan(&spec)
}

/// Creates a container for agents; its id.
#[tauri::command]
pub async fn docker_create(
    settings: State<'_, SettingsStore>,
    spec: ContainerSpec,
) -> Result<String, String> {
    let d = docker(&settings);
    blocking(move || d.create(&spec).map_err(String::from)).await
}

/// `action`: `start`, `stop` or `restart`.
#[tauri::command]
pub async fn docker_container_action(
    settings: State<'_, SettingsStore>,
    container: String,
    action: String,
) -> Result<(), String> {
    let d = docker(&settings);
    blocking(move || {
        match action.as_str() {
            "start" => d.start(&container),
            "stop" => d.stop(&container),
            "restart" => d.restart(&container),
            _ => return Err(format!("Nieznana operacja: {action}")),
        }
        .map_err(String::from)
    })
    .await
}

#[tauri::command]
pub async fn docker_remove_container(
    settings: State<'_, SettingsStore>,
    container: String,
    force: bool,
) -> Result<(), String> {
    let d = docker(&settings);
    blocking(move || d.remove(&container, force).map_err(String::from)).await
}

#[tauri::command]
pub async fn docker_remove_image(
    settings: State<'_, SettingsStore>,
    image: String,
) -> Result<(), String> {
    let d = docker(&settings);
    blocking(move || d.remove_image(&image).map_err(String::from)).await
}

#[tauri::command]
pub async fn docker_remove_volume(
    settings: State<'_, SettingsStore>,
    volume: String,
) -> Result<(), String> {
    let d = docker(&settings);
    blocking(move || d.remove_volume(&volume).map_err(String::from)).await
}

/// Removes unused images; what Docker freed (e.g. "Total reclaimed space: 1.2GB").
#[tauri::command]
pub async fn docker_prune_images(settings: State<'_, SettingsStore>) -> Result<String, String> {
    let d = docker(&settings);
    blocking(move || d.prune_images().map_err(String::from)).await
}

struct ChannelEvents(Channel<JobEvent>);

impl JobEvents for ChannelEvents {
    fn emit(&self, event: JobEvent) {
        let _ = self.0.send(event);
    }
}

fn start_job(
    settings: &SettingsStore,
    jobs: &DockerJobs,
    args: Result<Vec<String>, String>,
    on_event: Channel<JobEvent>,
) -> Result<u64, String> {
    jobs.start(&docker(settings), &args?, Arc::new(ChannelEvents(on_event)))
        .map_err(String::from)
}

/// Pulls an image; progress and end through `on_event`. Returns the job id (for `docker_cancel`).
#[tauri::command]
pub fn docker_pull(
    settings: State<'_, SettingsStore>,
    jobs: State<'_, DockerJobs>,
    image: String,
    on_event: Channel<JobEvent>,
) -> Result<u64, String> {
    start_job(&settings, &jobs, pull_args(&image), on_event)
}

/// Builds an image from a folder with a Dockerfile.
#[tauri::command]
pub fn docker_build(
    settings: State<'_, SettingsStore>,
    jobs: State<'_, DockerJobs>,
    dir: String,
    tag: String,
    dockerfile: Option<String>,
    on_event: Channel<JobEvent>,
) -> Result<u64, String> {
    start_job(
        &settings,
        &jobs,
        build_args(&dir, &tag, dockerfile.as_deref()),
        on_event,
    )
}

/// Follows a container's logs until `docker_cancel`.
#[tauri::command]
pub fn docker_logs(
    settings: State<'_, SettingsStore>,
    jobs: State<'_, DockerJobs>,
    container: String,
    on_event: Channel<JobEvent>,
) -> Result<u64, String> {
    start_job(&settings, &jobs, logs_args(&container), on_event)
}

#[tauri::command]
pub fn docker_cancel(jobs: State<'_, DockerJobs>, job: u64) {
    jobs.cancel(job);
}

/// Before a container profile's terminal opens: the container's state (started when `start`, or
/// when the profile starts it by itself) and the project folder's path in the container.
#[tauri::command]
pub async fn docker_prepare_container(
    settings: State<'_, SettingsStore>,
    profiles: State<'_, ProfileService>,
    profile_id: String,
    cwd: Option<String>,
    start: bool,
) -> Result<PreparedContainer, String> {
    let profile = profiles
        .resolve(&profile_id)
        .ok_or_else(|| format!("Profil „{profile_id}” nie istnieje"))?;
    let target = profile
        .container
        .ok_or_else(|| format!("{} nie jest profilem kontenera", profile.name))?;
    let d = docker(&settings);
    blocking(move || {
        let start = start || target.auto_start;
        d.prepare(&target, cwd.as_deref().map(std::path::Path::new), start)
            .map_err(|e| match e {
                super::DockerError::NoSuchObject(_) => format!(
                    "Kontenera {} już nie ma. Utwórz go ponownie w widoku Kontenery albo usuń profil.",
                    target.name
                ),
                e => e.to_string(),
            })
    })
    .await
}
