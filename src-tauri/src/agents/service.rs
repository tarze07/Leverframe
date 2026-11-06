use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use super::detect::AgentStatus;
use super::model::{load_catalog_from_dir, AgentCatalog, AgentDef, InstallHint};

/// What the UI needs about an agent; install hints already filtered for this platform.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub commands: Vec<String>,
    pub docs_url: Option<String>,
    pub install: Vec<InstallHint>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentsState {
    pub agents: Vec<AgentView>,
    /// Problems in the user's `agents.json`.
    pub errors: Vec<String>,
    pub config_path: String,
}

/// Agent definitions (built-in + `agents.json`) and cached detection results per profile.
pub struct AgentService {
    config_dir: PathBuf,
    statuses: Mutex<HashMap<String, Vec<AgentStatus>>>,
}

impl AgentService {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            config_dir: config_dir.to_path_buf(),
            statuses: Mutex::new(HashMap::new()),
        }
    }

    pub fn catalog(&self) -> AgentCatalog {
        load_catalog_from_dir(&self.config_dir)
    }

    pub fn state(&self) -> AgentsState {
        let catalog = self.catalog();
        AgentsState {
            agents: catalog
                .agents
                .iter()
                .map(|a| AgentView {
                    id: a.id.clone(),
                    name: a.name.clone(),
                    description: a.description.clone(),
                    commands: a.commands.clone(),
                    docs_url: a.docs_url.clone(),
                    install: a.install_for(cfg!(windows)).into_iter().cloned().collect(),
                })
                .collect(),
            errors: catalog.errors,
            config_path: self
                .config_dir
                .join("agents.json")
                .to_string_lossy()
                .into_owned(),
        }
    }

    pub fn find(&self, id: &str) -> Option<AgentDef> {
        self.catalog().agents.into_iter().find(|a| a.id == id)
    }

    pub fn cached(&self, profile_id: &str) -> Option<Vec<AgentStatus>> {
        self.statuses.lock().unwrap().get(profile_id).cloned()
    }

    pub fn store(&self, profile_id: &str, statuses: Vec<AgentStatus>) {
        self.statuses
            .lock()
            .unwrap()
            .insert(profile_id.to_string(), statuses);
    }

    /// Executable to type for an agent in a profile: the one found by detection, else the first name.
    pub fn command_for(&self, agent: &AgentDef, profile_id: Option<&str>) -> String {
        profile_id
            .and_then(|p| self.cached(p))
            .and_then(|list| list.into_iter().find(|s| s.id == agent.id))
            .and_then(|s| s.command)
            .unwrap_or_else(|| agent.commands[0].clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_for_prefers_detected_executable() {
        let svc = AgentService::new(&std::env::temp_dir().join("lf-agents-none"));
        let kilo = svc.find("kilo").unwrap();
        assert_eq!(svc.command_for(&kilo, Some("local:bash")), "kilo");
        svc.store(
            "local:bash",
            vec![AgentStatus {
                id: "kilo".into(),
                installed: true,
                command: Some("kilocode".into()),
                version: None,
            }],
        );
        assert_eq!(svc.command_for(&kilo, Some("local:bash")), "kilocode");
        assert_eq!(svc.command_for(&kilo, Some("other")), "kilo");
    }

    #[test]
    fn state_lists_agents_with_platform_install_hints() {
        let svc = AgentService::new(&std::env::temp_dir().join("lf-agents-none"));
        let state = svc.state();
        assert_eq!(state.agents.len(), 4);
        let claude = &state.agents[0];
        let expected = if cfg!(windows) {
            "install.ps1"
        } else {
            "install.sh"
        };
        assert_eq!(claude.install.len(), 1);
        assert!(claude.install[0].command.contains(expected));
        assert!(state.config_path.ends_with("agents.json"));
    }
}
