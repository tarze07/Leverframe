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

/// The CLI from the settings (`docker` when not set), for this machine's Docker.
pub fn docker(settings: &SettingsStore) -> Docker {
    Docker::new(
        settings
            .get_value(DOCKER_PATH_KEY)
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default(),
    )
}

/// The id of the SSH profile whose Docker the "Kontenery" view uses (`None`: this machine).
pub fn source_id(settings: &SettingsStore) -> Option<String> {
    settings
        .get_value(super::remote::DOCKER_SOURCE_KEY)
        .and_then(|v| v.as_str().map(String::from))
        .filter(|s| !s.is_empty())
}

/// The CLI for the Docker chosen in the "Kontenery" view: this machine or an SSH host.
pub fn current(profiles: &ProfileService) -> Result<Docker, String> {
    let d = docker(profiles.settings());
    match source_id(profiles.settings()) {
        None => Ok(d),
        Some(id) => {
            let (_, url) = super::remote::source(&profiles.all(), &id)?;
            Ok(d.with_env(super::remote::DOCKER_HOST, &url))
        }
    }
}

/// The CLI for a container profile: its Docker (`DOCKER_HOST` of a container on an SSH host is
/// in the profile's environment, see `ProfileService::all`).
pub fn for_profile(settings: &SettingsStore, profile: &crate::profiles::Profile) -> Docker {
    let d = docker(settings);
    match profile.env.get(super::remote::DOCKER_HOST) {
        Some(url) => d.with_env(super::remote::DOCKER_HOST, url),
        None => d,
    }
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
pub async fn docker_info(profiles: State<'_, ProfileService>) -> Result<DockerInfo, String> {
    let d = current(&profiles)?;
    blocking(move || Ok(d.info())).await
}

#[tauri::command]
pub async fn docker_images(
    profiles: State<'_, ProfileService>,
) -> Result<Vec<DockerImage>, String> {
    let d = current(&profiles)?;
    blocking(move || d.images().map_err(String::from)).await
}

#[tauri::command]
pub async fn docker_containers(
    profiles: State<'_, ProfileService>,
) -> Result<Vec<DockerContainer>, String> {
    let d = current(&profiles)?;
    blocking(move || d.containers().map_err(String::from)).await
}

#[tauri::command]
pub async fn docker_volumes(
    profiles: State<'_, ProfileService>,
) -> Result<Vec<DockerVolume>, String> {
    let d = current(&profiles)?;
    blocking(move || d.volumes().map_err(String::from)).await
}

#[tauri::command]
pub async fn docker_inspect(
    profiles: State<'_, ProfileService>,
    container: String,
) -> Result<ContainerDetails, String> {
    let d = current(&profiles)?;
    blocking(move || d.inspect(&container).map_err(String::from)).await
}

/// What creating the container will do: `docker run` and warnings (shown before it runs).
#[tauri::command]
pub fn docker_create_plan(
    profiles: State<'_, ProfileService>,
    mut spec: ContainerSpec,
) -> Result<CreatePlan, String> {
    spec.on_ssh_host = source_id(profiles.settings()).is_some();
    plan(&spec)
}

/// Creates a container for agents; its id.
#[tauri::command]
pub async fn docker_create(
    profiles: State<'_, ProfileService>,
    mut spec: ContainerSpec,
) -> Result<String, String> {
    spec.on_ssh_host = source_id(profiles.settings()).is_some();
    let d = current(&profiles)?;
    blocking(move || d.create(&spec).map_err(String::from)).await
}

/// `action`: `start`, `stop` or `restart`.
#[tauri::command]
pub async fn docker_container_action(
    profiles: State<'_, ProfileService>,
    container: String,
    action: String,
) -> Result<(), String> {
    let d = current(&profiles)?;
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
    profiles: State<'_, ProfileService>,
    container: String,
    force: bool,
) -> Result<(), String> {
    let d = current(&profiles)?;
    blocking(move || d.remove(&container, force).map_err(String::from)).await
}

#[tauri::command]
pub async fn docker_remove_image(
    profiles: State<'_, ProfileService>,
    image: String,
) -> Result<(), String> {
    let d = current(&profiles)?;
    blocking(move || d.remove_image(&image).map_err(String::from)).await
}

#[tauri::command]
pub async fn docker_remove_volume(
    profiles: State<'_, ProfileService>,
    volume: String,
) -> Result<(), String> {
    let d = current(&profiles)?;
    blocking(move || d.remove_volume(&volume).map_err(String::from)).await
}

/// Removes unused images; what Docker freed (e.g. "Total reclaimed space: 1.2GB").
#[tauri::command]
pub async fn docker_prune_images(profiles: State<'_, ProfileService>) -> Result<String, String> {
    let d = current(&profiles)?;
    blocking(move || d.prune_images().map_err(String::from)).await
}

struct ChannelEvents(Channel<JobEvent>);

impl JobEvents for ChannelEvents {
    fn emit(&self, event: JobEvent) {
        let _ = self.0.send(event);
    }
}

fn start_job(
    profiles: &ProfileService,
    jobs: &DockerJobs,
    args: Result<Vec<String>, String>,
    on_event: Channel<JobEvent>,
) -> Result<u64, String> {
    jobs.start(
        &current(profiles)?,
        &args?,
        Arc::new(ChannelEvents(on_event)),
    )
    .map_err(String::from)
}

/// Pulls an image; progress and end through `on_event`. Returns the job id (for `docker_cancel`).
#[tauri::command]
pub fn docker_pull(
    profiles: State<'_, ProfileService>,
    jobs: State<'_, DockerJobs>,
    image: String,
    on_event: Channel<JobEvent>,
) -> Result<u64, String> {
    start_job(&profiles, &jobs, pull_args(&image), on_event)
}

/// Builds an image from a folder with a Dockerfile.
#[tauri::command]
pub fn docker_build(
    profiles: State<'_, ProfileService>,
    jobs: State<'_, DockerJobs>,
    dir: String,
    tag: String,
    dockerfile: Option<String>,
    on_event: Channel<JobEvent>,
) -> Result<u64, String> {
    start_job(
        &profiles,
        &jobs,
        build_args(&dir, &tag, dockerfile.as_deref()),
        on_event,
    )
}

/// Name of the image with agents of this version (`leverframe-agents:<version>`).
#[tauri::command]
pub fn docker_agents_image() -> String {
    super::image::agents_image_tag()
}

/// Builds the image with agents from the `Dockerfile` shipped with the app.
#[tauri::command]
pub fn docker_build_agents_image(
    profiles: State<'_, ProfileService>,
    jobs: State<'_, DockerJobs>,
    on_event: Channel<JobEvent>,
) -> Result<u64, String> {
    let dir = super::image::agents_build_dir(&std::env::temp_dir())
        .map_err(|e| format!("Nie można zapisać pliku Dockerfile: {e}"))?;
    let args = build_args(
        &dir.to_string_lossy(),
        &super::image::agents_image_tag(),
        None,
    );
    start_job(&profiles, &jobs, args, on_event)
}

/// Follows a container's logs until `docker_cancel`.
#[tauri::command]
pub fn docker_logs(
    profiles: State<'_, ProfileService>,
    jobs: State<'_, DockerJobs>,
    container: String,
    on_event: Channel<JobEvent>,
) -> Result<u64, String> {
    start_job(&profiles, &jobs, logs_args(&container), on_event)
}

#[tauri::command]
pub fn docker_cancel(jobs: State<'_, DockerJobs>, job: u64) {
    jobs.cancel(job);
}

/// Before a container profile's terminal opens: the container's state (started when `start`, or
/// when the profile starts it by itself) and the project folder's path in the container.
#[tauri::command]
pub async fn docker_prepare_container(
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
        .clone()
        .ok_or_else(|| format!("{} nie jest profilem kontenera", profile.name))?;
    let d = for_profile(profiles.settings(), &profile);
    let remote = target.host.is_some();
    blocking(move || {
        let start = start || target.auto_start;
        // On an SSH host the folders of this machine are not in the container.
        let cwd = if remote { None } else { cwd };
        d.prepare(&target, cwd.as_deref().map(std::path::Path::new), start)
            .map(|p| super::terminal::PreparedContainer { remote, ..p })
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

/// A Docker the "Kontenery" view can show: this machine or an SSH host.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerSource {
    /// SSH profile id; `None`: this machine.
    pub id: Option<String>,
    pub name: String,
    /// `DOCKER_HOST` (SSH hosts).
    pub url: Option<String>,
    /// Why it may not work (e.g. a key file the docker CLI does not pass to ssh).
    pub warning: Option<String>,
}

/// This machine and every SSH profile, and which one is chosen.
pub fn sources(profiles: &[crate::profiles::Profile]) -> Vec<DockerSource> {
    let mut list = vec![DockerSource {
        id: None,
        name: "Ten komputer".into(),
        url: None,
        warning: None,
    }];
    for p in profiles
        .iter()
        .filter(|p| p.kind == crate::profiles::ProfileKind::Ssh)
    {
        let Some(target) = &p.ssh else { continue };
        let (url, mut warning) = match super::remote::docker_host_url(target) {
            Ok(url) => (Some(url), None),
            Err(e) => (None, Some(e)),
        };
        if let Some(key) = target.identity_file.as_deref().filter(|k| !k.is_empty()) {
            warning.get_or_insert(format!(
                "Docker łączy się przez ssh bez pliku klucza z profilu ({key}) – dodaj klucz do agenta SSH (ssh-add) albo do ~/.ssh/config."
            ));
        }
        list.push(DockerSource {
            id: Some(p.id.clone()),
            name: p.name.clone(),
            url,
            warning,
        });
    }
    list
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerSources {
    pub sources: Vec<DockerSource>,
    /// The chosen one (`None`: this machine).
    pub current: Option<String>,
}

#[tauri::command]
pub fn docker_sources(profiles: State<'_, ProfileService>) -> DockerSources {
    DockerSources {
        sources: sources(&profiles.all()),
        current: source_id(profiles.settings()),
    }
}

/// Chooses the Docker of the "Kontenery" view: an SSH profile's id, or `None` for this machine.
/// Containers made for Leverframe there become profiles.
#[tauri::command]
pub fn docker_set_source(
    profiles: State<'_, ProfileService>,
    id: Option<String>,
) -> Result<DockerSources, String> {
    if let Some(id) = &id {
        super::remote::source(&profiles.all(), id)?;
    }
    let value = id
        .clone()
        .map(serde_json::Value::String)
        .unwrap_or(serde_json::Value::Null);
    profiles
        .settings()
        .set(super::remote::DOCKER_SOURCE_KEY, value)?;
    Ok(docker_sources(profiles))
}
