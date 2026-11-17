use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use super::detect::AgentStatus;
use super::model::{
    hints_for, load_catalog, load_catalog_from_dir, AgentCatalog, AgentDef, InstallHint,
    BUILTIN_AGENTS_JSON,
};
use super::settings::{save_settings, AgentSettings};

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
    /// ACP mode (conversation in Leverframe), if the agent has one.
    pub acp: Option<AcpView>,
    /// Arguments added in a terminal (settings).
    pub args: Vec<String>,
    /// Environment of the agent (settings).
    pub env: BTreeMap<String, String>,
    /// Hidden in the view (settings).
    pub hidden: bool,
    /// Defined by Leverframe (not only in the user's `agents.json`).
    pub builtin: bool,
    /// The built-in conversation-mode command line (what "default" means in the settings).
    pub default_acp: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpView {
    pub command: String,
    pub args: Vec<String>,
    /// Adapter install hints for this platform.
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

    /// Saves an agent's settings; detection results are dropped (the conversation-mode program
    /// may have changed).
    pub fn save_settings(&self, id: &str, settings: &AgentSettings) -> Result<(), String> {
        save_settings(&self.config_dir, id, settings)?;
        self.statuses.lock().unwrap().clear();
        Ok(())
    }

    pub fn state(&self) -> AgentsState {
        let catalog = self.catalog();
        let builtin = load_catalog(BUILTIN_AGENTS_JSON, None).agents;
        let builtin_of = |id: &str| builtin.iter().find(|b| b.id == id);
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
                    acp: a.acp.as_ref().map(|acp| AcpView {
                        command: acp.command.clone(),
                        args: acp.args.clone(),
                        install: hints_for(&acp.install, cfg!(windows))
                            .into_iter()
                            .cloned()
                            .collect(),
                    }),
                    args: a.args.clone(),
                    env: a.env.clone(),
                    hidden: a.hidden,
                    builtin: builtin_of(&a.id).is_some(),
                    default_acp: builtin_of(&a.id)
                        .and_then(|b| b.acp.as_ref())
                        .map(|acp| acp.command_line()),
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
        let dir = std::env::temp_dir().join(format!("lf-agents-cmd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("agents.json"),
            r#"{ "agents": [{ "id": "aider", "name": "Aider", "commands": ["aider", "aider-chat"] }] }"#,
        )
        .unwrap();
        let svc = AgentService::new(&dir);
        let aider = svc.find("aider").unwrap();
        assert_eq!(svc.command_for(&aider, Some("local:bash")), "aider");
        svc.store(
            "local:bash",
            vec![AgentStatus {
                id: "aider".into(),
                installed: true,
                command: Some("aider-chat".into()),
                version: None,
                acp: None,
            }],
        );
        assert_eq!(svc.command_for(&aider, Some("local:bash")), "aider-chat");
        assert_eq!(svc.command_for(&aider, Some("other")), "aider");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn settings_are_saved_and_shown_with_the_defaults() {
        let dir = std::env::temp_dir().join(format!("lf-agents-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let svc = AgentService::new(&dir);
        let settings = AgentSettings {
            args: vec!["--model".into(), "openai/gpt-5".into()],
            env: [(
                "OPENCODE_CONFIG".to_string(),
                "/home/me/oc.json".to_string(),
            )]
            .into(),
            acp: Some(vec!["opencode".into(), "acp".into(), "--print-logs".into()]),
            hidden: false,
        };
        svc.save_settings("opencode", &settings).unwrap();
        let state = svc.state();
        let oc = state.agents.iter().find(|a| a.id == "opencode").unwrap();
        assert_eq!(oc.args, settings.args);
        assert_eq!(oc.env, settings.env);
        assert_eq!(oc.acp.as_ref().unwrap().args, ["acp", "--print-logs"]);
        assert_eq!(
            oc.default_acp.as_deref(),
            Some(&["opencode".to_string(), "acp".to_string()][..])
        );
        assert!(oc.builtin && !oc.hidden);
        svc.save_settings(
            "opencode",
            &AgentSettings {
                hidden: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            svc.state()
                .agents
                .iter()
                .find(|a| a.id == "opencode")
                .unwrap()
                .hidden
        );
        assert!(svc
            .save_settings(
                "opencode",
                &AgentSettings {
                    args: vec!["`x`".into()],
                    ..Default::default()
                }
            )
            .is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn state_lists_agents_with_platform_install_hints() {
        let svc = AgentService::new(&std::env::temp_dir().join("lf-agents-none"));
        let state = svc.state();
        assert_eq!(state.agents.len(), 5);
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
