use std::path::Path;

use serde::{Deserialize, Serialize};

/// Built-in definitions, shipped with the app. Users override/extend them in `<config>/agents.json`.
pub const BUILTIN_AGENTS_JSON: &str = include_str!("../../resources/agents.json");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallHint {
    /// `unix`, `windows` or `any`.
    pub platform: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Executable names, tried in order (e.g. `kilo`, then the older `kilocode`).
    pub commands: Vec<String>,
    #[serde(default = "default_version_args")]
    pub version_args: Vec<String>,
    #[serde(default)]
    pub docs_url: Option<String>,
    /// Official install commands – shown to the user, never executed by the app.
    #[serde(default)]
    pub install: Vec<InstallHint>,
}

fn default_version_args() -> Vec<String> {
    vec!["--version".into()]
}

/// An entry of `agents.json`: a full definition, or a partial override of a built-in one.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentEntry {
    id: String,
    name: Option<String>,
    description: Option<String>,
    commands: Option<Vec<String>>,
    version_args: Option<Vec<String>>,
    docs_url: Option<String>,
    install: Option<Vec<InstallHint>>,
    #[serde(default)]
    disabled: bool,
}

#[derive(Debug, Default, Deserialize)]
struct AgentsFile {
    #[serde(default)]
    agents: Vec<AgentEntry>,
}

/// Names and arguments end up in shell scripts, so only plain tokens are accepted.
pub fn is_safe_token(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._+-=".contains(c))
}

fn is_safe_command(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
}

impl AgentDef {
    fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || !self
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(format!("Nieprawidłowe id agenta: {:?}", self.id));
        }
        if self.commands.is_empty() || !self.commands.iter().all(|c| is_safe_command(c)) {
            return Err(format!(
                "Agent {}: nieprawidłowe komendy {:?}",
                self.id, self.commands
            ));
        }
        if !self.version_args.iter().all(|a| is_safe_token(a)) {
            return Err(format!("Agent {}: nieprawidłowe argumenty wersji", self.id));
        }
        Ok(())
    }

    /// Install hints for the current platform.
    pub fn install_for(&self, windows: bool) -> Vec<&InstallHint> {
        let platform = if windows { "windows" } else { "unix" };
        self.install
            .iter()
            .filter(|h| h.platform == "any" || h.platform == platform)
            .collect()
    }
}

fn apply(entries: Vec<AgentEntry>, into: &mut Vec<AgentDef>, errors: &mut Vec<String>) {
    for e in entries {
        if e.disabled {
            into.retain(|a| a.id != e.id);
            continue;
        }
        let def = match into.iter().position(|a| a.id == e.id) {
            Some(i) => {
                let base = &into[i];
                AgentDef {
                    id: e.id,
                    name: e.name.unwrap_or_else(|| base.name.clone()),
                    description: e.description.or_else(|| base.description.clone()),
                    commands: e.commands.unwrap_or_else(|| base.commands.clone()),
                    version_args: e.version_args.unwrap_or_else(|| base.version_args.clone()),
                    docs_url: e.docs_url.or_else(|| base.docs_url.clone()),
                    install: e.install.unwrap_or_else(|| base.install.clone()),
                }
            }
            None => AgentDef {
                name: e.name.unwrap_or_else(|| e.id.clone()),
                id: e.id,
                description: e.description,
                commands: e.commands.unwrap_or_default(),
                version_args: e.version_args.unwrap_or_else(default_version_args),
                docs_url: e.docs_url,
                install: e.install.unwrap_or_default(),
            },
        };
        if let Err(err) = def.validate() {
            errors.push(err);
            continue;
        }
        match into.iter().position(|a| a.id == def.id) {
            Some(i) => into[i] = def,
            None => into.push(def),
        }
    }
}

/// Loaded agent definitions plus any problems found in the user's `agents.json`.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalog {
    pub agents: Vec<AgentDef>,
    pub errors: Vec<String>,
}

pub fn load_catalog(builtin_json: &str, user_json: Option<&str>) -> AgentCatalog {
    let mut agents = Vec::new();
    let mut errors = Vec::new();
    match serde_json::from_str::<AgentsFile>(builtin_json) {
        Ok(f) => apply(f.agents, &mut agents, &mut errors),
        Err(e) => errors.push(format!("Wbudowane agents.json: {e}")),
    }
    if let Some(json) = user_json {
        match serde_json::from_str::<AgentsFile>(json) {
            Ok(f) => apply(f.agents, &mut agents, &mut errors),
            Err(e) => errors.push(format!("agents.json: {e}")),
        }
    }
    AgentCatalog { agents, errors }
}

pub fn load_catalog_from_dir(config_dir: &Path) -> AgentCatalog {
    let user = std::fs::read_to_string(config_dir.join("agents.json")).ok();
    load_catalog(BUILTIN_AGENTS_JSON, user.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_catalog_is_valid() {
        let c = load_catalog(BUILTIN_AGENTS_JSON, None);
        assert!(c.errors.is_empty(), "{:?}", c.errors);
        let ids: Vec<_> = c.agents.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["claude", "codex", "agy", "kilo"]);
        let kilo = &c.agents[3];
        assert_eq!(kilo.commands, ["kilo", "kilocode"]);
        assert_eq!(kilo.version_args, ["--version"]);
    }

    #[test]
    fn user_file_overrides_adds_and_disables() {
        let user = r#"{ "agents": [
            { "id": "codex", "commands": ["codex-beta"] },
            { "id": "agy", "disabled": true },
            { "id": "aider", "name": "Aider", "commands": ["aider"], "versionArgs": ["--version"] }
        ] }"#;
        let c = load_catalog(BUILTIN_AGENTS_JSON, Some(user));
        assert!(c.errors.is_empty(), "{:?}", c.errors);
        let ids: Vec<_> = c.agents.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["claude", "codex", "kilo", "aider"]);
        let codex = c.agents.iter().find(|a| a.id == "codex").unwrap();
        assert_eq!(codex.commands, ["codex-beta"]);
        assert_eq!(
            codex.name, "Codex",
            "unspecified fields keep built-in values"
        );
    }

    #[test]
    fn rejects_unsafe_definitions_but_keeps_the_rest() {
        let user = r#"{ "agents": [
            { "id": "evil", "commands": ["rm -rf /"] },
            { "id": "evil2", "commands": ["x"], "versionArgs": ["$(reboot)"] },
            { "id": "ok", "commands": ["ok-cli"] }
        ] }"#;
        let c = load_catalog(BUILTIN_AGENTS_JSON, Some(user));
        assert_eq!(c.errors.len(), 2);
        assert!(c.agents.iter().any(|a| a.id == "ok"));
        assert!(!c.agents.iter().any(|a| a.id.starts_with("evil")));
    }

    #[test]
    fn broken_user_file_is_reported() {
        let c = load_catalog(BUILTIN_AGENTS_JSON, Some("{ nope"));
        assert_eq!(c.agents.len(), 4);
        assert_eq!(c.errors.len(), 1);
    }

    #[test]
    fn install_hints_per_platform() {
        let c = load_catalog(BUILTIN_AGENTS_JSON, None);
        let claude = &c.agents[0];
        assert!(claude.install_for(false)[0].command.contains("install.sh"));
        assert!(claude.install_for(true)[0].command.contains("install.ps1"));
        assert_eq!(
            c.agents[1].install_for(true).len(),
            1,
            "`any` applies everywhere"
        );
    }
}
