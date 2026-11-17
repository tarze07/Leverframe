use std::time::Duration;

use tauri::State;

use super::detect::{detect, AgentStatus};
use super::service::{AgentService, AgentsState};
use super::settings::AgentSettings;
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
    // Hidden agents are not checked (the view does not show them).
    let defs: Vec<_> = agents
        .catalog()
        .agents
        .into_iter()
        .filter(|a| !a.hidden)
        .collect();
    let docker = crate::docker::commands::docker(profiles.settings());
    // Detection runs processes (and may wait on the network for SSH): keep it off the async workers.
    let result = tauri::async_runtime::spawn_blocking(move || {
        // A container must run to be checked: started when its profile starts it by itself.
        if let Some(target) = &profile.container {
            let prepared = docker
                .prepare(target, None, target.auto_start)
                .map_err(String::from)?;
            if !prepared.running {
                return Err(format!(
                    "Kontener {} jest zatrzymany – uruchom go w widoku „Kontenery”, aby sprawdzić agentów.",
                    target.name
                ));
            }
        }
        detect(&profile, &defs, DETECT_TIMEOUT)
    })
    .await
    .map_err(|e| e.to_string())??;
    agents.store(&profile_id, result.clone());
    Ok(result)
}

/// Saves an agent's settings (arguments, environment, conversation-mode command, hidden) in the
/// user's `agents.json`; returns the agents as they are now.
#[tauri::command]
pub async fn agents_save_settings(
    agents: State<'_, AgentService>,
    id: String,
    settings: AgentSettings,
) -> Result<AgentsState, String> {
    agents.save_settings(&id, &settings)?;
    Ok(agents.state())
}
