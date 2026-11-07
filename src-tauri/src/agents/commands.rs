use std::time::Duration;

use tauri::State;

use super::detect::{detect, AgentStatus};
use super::service::{AgentService, AgentsState};
use crate::profiles::ProfileService;

const DETECT_TIMEOUT: Duration = Duration::from_secs(25);

#[tauri::command]
pub async fn agents_list(agents: State<'_, AgentService>) -> Result<AgentsState, String> {
    Ok(agents.state())
}

/// Checks which agents are installed in a profile. Cached per profile unless `force`.
#[tauri::command]
pub async fn agents_detect(
    agents: State<'_, AgentService>,
    profiles: State<'_, ProfileService>,
    profile_id: String,
    force: bool,
) -> Result<Vec<AgentStatus>, String> {
    if !force {
        if let Some(cached) = agents.cached(&profile_id) {
            return Ok(cached);
        }
    }
    let profile = profiles
        .resolve(&profile_id)
        .ok_or_else(|| format!("Profil „{profile_id}” nie istnieje"))?;
    let defs = agents.catalog().agents;
    // Detection runs processes (and may wait on the network for SSH): keep it off the async workers.
    let result =
        tauri::async_runtime::spawn_blocking(move || detect(&profile, &defs, DETECT_TIMEOUT))
            .await
            .map_err(|e| e.to_string())??;
    agents.store(&profile_id, result.clone());
    Ok(result)
}
