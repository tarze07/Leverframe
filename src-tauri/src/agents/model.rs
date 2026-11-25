use std::collections::BTreeMap;
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

/// How to start the agent in ACP mode (Agent Client Protocol over stdio), see docs/ACP.md.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpDef {
    /// Program speaking ACP: the agent itself (`gemini` + `--acp`) or an adapter (`claude-agent-acp`).
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Install commands for the adapter – shown, never executed.
    #[serde(default)]
    pub install: Vec<InstallHint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Executable names, tried in order (e.g. a new name, then an older one).
    pub commands: Vec<String>,
    #[serde(default = "default_version_args")]
    pub version_args: Vec<String>,
    #[serde(default)]
    pub docs_url: Option<String>,
    /// Official install commands – shown to the user, never executed by the app.
    #[serde(default)]
    pub install: Vec<InstallHint>,
    /// ACP mode; `None` = terminal only.
    #[serde(default)]
    pub acp: Option<AcpDef>,
    /// Arguments added after the command in a terminal (e.g. `--model`); settings of the user.
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment of the agent (terminal and conversation mode); settings of the user.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Hidden in the "Agenci" view (`"disabled": true` in `agents.json`).
    #[serde(default)]
    pub hidden: bool,
    /// How a first prompt is given in a terminal (tasks, #107): `""` – as the last argument
    /// (`claude "…"`), or a flag before it (`gemini -i "…"`). `None`: the agent takes none.
    #[serde(default)]
    pub prompt_arg: Option<String>,
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
    /// Missing = keep the built-in value; `null` = remove ACP mode; object = replace it.
    #[serde(default, deserialize_with = "present")]
    acp: Option<Option<AcpDef>>,
    args: Option<Vec<String>>,
    env: Option<BTreeMap<String, String>>,
    /// Missing = keep the built-in value; `null` = none.
    #[serde(default, deserialize_with = "present")]
    prompt_arg: Option<Option<String>>,
    #[serde(default)]
    disabled: bool,
}

/// Tells a field set to `null` (`Some(None)`) from a missing one (`None`).
fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
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

/// Arguments and values typed into shells or put into launch scripts, always quoted there: any
/// text without control characters and without characters some shell would still expand inside
/// quotes (`$`, `` ` ``, `"`, `%`).
pub fn is_safe_arg(s: &str) -> bool {
    !s.is_empty() && !s.chars().any(|c| c.is_control() || "$`\"%".contains(c))
}

/// Environment variable names: letters, digits and `_`, not starting with a digit.
pub fn is_env_name(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
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
        if let Some(acp) = &self.acp {
            // The command also goes into the detection script, the arguments into the launch script.
            if !is_safe_command(&acp.command) || !acp.args.iter().all(|a| is_safe_arg(a)) {
                return Err(format!(
                    "Agent {}: nieprawidłowa komenda ACP {:?} {:?}",
                    self.id, acp.command, acp.args
                ));
            }
        }
        if let Some(flag) = &self.prompt_arg {
            if !flag.is_empty() && !is_safe_token(flag) {
                return Err(format!(
                    "Agent {}: nieprawidłowy promptArg {flag:?}",
                    self.id
                ));
            }
        }
        if let Some(bad) = self.args.iter().find(|a| !is_safe_arg(a)) {
            return Err(format!(
                "Agent {}: nieprawidłowy argument {bad:?} (bez znaków $ ` \" % i znaków sterujących)",
                self.id
            ));
        }
        for (name, value) in &self.env {
            if !is_env_name(name) {
                return Err(format!(
                    "Agent {}: nieprawidłowa nazwa zmiennej {name:?}",
                    self.id
                ));
            }
            if !value.is_empty() && !is_safe_arg(value) {
                return Err(format!(
                    "Agent {}: nieprawidłowa wartość zmiennej {name} (bez znaków $ ` \" % i znaków sterujących)",
                    self.id
                ));
            }
        }
        Ok(())
    }

    /// Install hints for the current platform.
    pub fn install_for(&self, windows: bool) -> Vec<&InstallHint> {
        hints_for(&self.install, windows)
    }
}

/// Install hints that apply on this platform (`any` everywhere).
pub fn hints_for(hints: &[InstallHint], windows: bool) -> Vec<&InstallHint> {
    let platform = if windows { "windows" } else { "unix" };
    hints
        .iter()
        .filter(|h| h.platform == "any" || h.platform == platform)
        .collect()
}

impl AcpDef {
    /// Program and arguments for `acp_start`.
    pub fn command_line(&self) -> Vec<String> {
        std::iter::once(self.command.clone())
            .chain(self.args.iter().cloned())
            .collect()
    }
}

fn apply(entries: Vec<AgentEntry>, into: &mut Vec<AgentDef>, errors: &mut Vec<String>) {
    for e in entries {
        let known = into.iter().any(|a| a.id == e.id);
        // Hiding an agent that does not exist hides nothing.
        if e.disabled && !known && e.commands.is_none() {
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
                    acp: match e.acp {
                        None => base.acp.clone(),
                        // A changed command keeps the built-in install hints.
                        Some(Some(mut acp)) => {
                            if acp.install.is_empty() {
                                acp.install = base
                                    .acp
                                    .as_ref()
                                    .map(|b| b.install.clone())
                                    .unwrap_or_default();
                            }
                            Some(acp)
                        }
                        Some(None) => None,
                    },
                    args: e.args.unwrap_or_else(|| base.args.clone()),
                    env: e.env.unwrap_or_else(|| base.env.clone()),
                    hidden: e.disabled,
                    prompt_arg: match e.prompt_arg {
                        None => base.prompt_arg.clone(),
                        Some(p) => p,
                    },
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
                acp: e.acp.flatten(),
                args: e.args.unwrap_or_default(),
                env: e.env.unwrap_or_default(),
                hidden: e.disabled,
                prompt_arg: e.prompt_arg.flatten(),
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
        assert_eq!(ids, ["claude", "codex", "gemini", "agy", "opencode"]);
        let opencode = &c.agents[4];
        assert_eq!(opencode.commands, ["opencode"]);
        assert_eq!(opencode.version_args, ["--version"]);
        assert!(c
            .agents
            .iter()
            .all(|a| a.args.is_empty() && a.env.is_empty() && !a.hidden));
        // ACP mode: adapters for Claude and Codex, Gemini CLI and OpenCode themselves; not confirmed for Agy.
        let acp: Vec<_> = c
            .agents
            .iter()
            .map(|a| a.acp.as_ref().map(|x| x.command_line().join(" ")))
            .collect();
        assert_eq!(
            acp,
            [
                Some("claude-agent-acp".to_string()),
                Some("codex-acp".to_string()),
                Some("gemini --acp".to_string()),
                None,
                Some("opencode acp".to_string())
            ]
        );
        assert!(c.agents[0].acp.as_ref().unwrap().install[0]
            .command
            .contains("@agentclientprotocol/claude-agent-acp"));
    }

    #[test]
    fn acp_mode_can_be_added_replaced_or_removed_by_the_user() {
        let user = r#"{ "agents": [
            { "id": "agy", "acp": { "command": "agy", "args": ["acp"] } },
            { "id": "codex", "name": "Codex (beta)" },
            { "id": "claude", "acp": null },
            { "id": "gemini", "acp": { "command": "gemini", "args": ["--experimental-acp"] } }
        ] }"#;
        let c = load_catalog(BUILTIN_AGENTS_JSON, Some(user));
        assert!(c.errors.is_empty(), "{:?}", c.errors);
        let by_id = |id: &str| c.agents.iter().find(|a| a.id == id).unwrap();
        assert_eq!(
            by_id("agy").acp.as_ref().unwrap().command_line(),
            ["agy", "acp"]
        );
        assert_eq!(
            by_id("codex").acp.as_ref().unwrap().command,
            "codex-acp",
            "kept when not mentioned"
        );
        assert_eq!(by_id("claude").acp, None, "null removes it");
        assert_eq!(
            by_id("gemini").acp.as_ref().unwrap().args,
            ["--experimental-acp"]
        );
    }

    #[test]
    fn a_changed_conversation_command_keeps_the_install_hints() {
        let user = r#"{ "agents": [{ "id": "claude", "acp": { "command": "claude-agent-acp", "args": ["--debug"] } }] }"#;
        let c = load_catalog(BUILTIN_AGENTS_JSON, Some(user));
        let acp = c.agents[0].acp.as_ref().unwrap();
        assert_eq!(acp.args, ["--debug"]);
        assert!(acp.install[0].command.contains("claude-agent-acp"));
    }

    #[test]
    fn arguments_and_variables_of_the_user() {
        let user = r#"{ "agents": [
            { "id": "opencode", "args": ["--model", "anthropic/claude sonnet"], "env": { "OPENCODE_CONFIG": "/home/me/oc.json" } },
            { "id": "codex", "args": ["$(id)"] },
            { "id": "gemini", "env": { "BAD-NAME": "x" } },
            { "id": "agy", "env": { "KEY": "a%PATH%" } }
        ] }"#;
        let c = load_catalog(BUILTIN_AGENTS_JSON, Some(user));
        assert_eq!(c.errors.len(), 3, "{:?}", c.errors);
        let oc = c.agents.iter().find(|a| a.id == "opencode").unwrap();
        assert_eq!(oc.args, ["--model", "anthropic/claude sonnet"]);
        assert_eq!(oc.env["OPENCODE_CONFIG"], "/home/me/oc.json");
        // A refused entry leaves the built-in agent as it was.
        assert!(c
            .agents
            .iter()
            .find(|a| a.id == "codex")
            .unwrap()
            .args
            .is_empty());
    }

    #[test]
    fn unsafe_acp_commands_are_rejected() {
        let user = r#"{ "agents": [
            { "id": "a", "commands": ["a"], "acp": { "command": "a; rm -rf ~" } },
            { "id": "b", "commands": ["b"], "acp": { "command": "b", "args": ["$(id)"] } },
            { "id": "c", "commands": ["c"], "acp": { "command": "c-acp", "args": ["--port=0"] } }
        ] }"#;
        let c = load_catalog(BUILTIN_AGENTS_JSON, Some(user));
        assert_eq!(c.errors.len(), 2, "{:?}", c.errors);
        assert!(c.agents.iter().any(|a| a.id == "c"));
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
        // A disabled agent stays, hidden (the view can show it again).
        assert_eq!(
            ids,
            ["claude", "codex", "gemini", "agy", "opencode", "aider"]
        );
        assert!(c.agents.iter().find(|a| a.id == "agy").unwrap().hidden);
        let unknown = load_catalog(
            BUILTIN_AGENTS_JSON,
            Some(r#"{ "agents": [{ "id": "nope", "disabled": true }] }"#),
        );
        assert!(unknown.errors.is_empty() && unknown.agents.len() == 5);
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
        assert_eq!(c.agents.len(), 5);
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
