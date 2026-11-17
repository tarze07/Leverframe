//! Settings of an agent changed in the "Agenci" view: arguments, environment, the command of the
//! conversation mode and hiding. Saved as an override in the user's `agents.json` (the same file
//! users edit by hand): other fields and other agents' entries stay as they are.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::model::{load_catalog, BUILTIN_AGENTS_JSON};

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    /// Added after the agent's command in a terminal.
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Program and arguments of the conversation mode; `None` = the built-in ones.
    #[serde(default)]
    pub acp: Option<Vec<String>>,
    #[serde(default)]
    pub hidden: bool,
}

/// The fields of an `agents.json` entry these settings own.
const OWNED: [&str; 4] = ["args", "env", "acp", "disabled"];

/// `agents.json` with the agent's entry changed to `settings`. Fails (without writing anything)
/// when the result would not load.
pub fn apply_settings(
    user_json: Option<&str>,
    id: &str,
    settings: &AgentSettings,
) -> Result<String, String> {
    let mut root: Value = match user_json.map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => serde_json::from_str(text).map_err(|e| format!("agents.json: {e}"))?,
        None => json!({ "agents": [] }),
    };
    let root_map = root
        .as_object_mut()
        .ok_or("agents.json: oczekiwano obiektu z listą \"agents\"")?;
    let agents = root_map
        .entry("agents")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or("agents.json: \"agents\" musi być listą")?;

    let builtin = load_catalog(BUILTIN_AGENTS_JSON, None)
        .agents
        .into_iter()
        .find(|a| a.id == id);
    let mut entry = match agents
        .iter()
        .position(|e| e.get("id").and_then(Value::as_str) == Some(id))
    {
        Some(i) => match agents.remove(i) {
            Value::Object(m) => m,
            _ => Map::new(),
        },
        None => Map::new(),
    };
    for key in OWNED {
        entry.remove(key);
    }
    let mut add = Map::new();
    add.insert("id".into(), Value::String(id.into()));
    if !settings.args.is_empty() {
        add.insert("args".into(), json!(settings.args));
    }
    if !settings.env.is_empty() {
        add.insert("env".into(), json!(settings.env));
    }
    if let Some(line) = &settings.acp {
        let line: Vec<String> = line
            .iter()
            .map(|w| w.trim().to_string())
            .filter(|w| !w.is_empty())
            .collect();
        let default = builtin
            .as_ref()
            .and_then(|b| b.acp.as_ref())
            .map(|a| a.command_line());
        if !line.is_empty() && Some(&line) != default.as_ref() {
            add.insert(
                "acp".into(),
                json!({ "command": line[0], "args": line[1..] }),
            );
        }
    }
    if settings.hidden {
        add.insert("disabled".into(), Value::Bool(true));
    }
    // The id first, then what the user wrote by hand, then the settings.
    let mut merged = Map::new();
    merged.insert("id".into(), Value::String(id.into()));
    for (k, v) in entry.into_iter().filter(|(k, _)| k != "id") {
        merged.insert(k, v);
    }
    for (k, v) in add.into_iter().filter(|(k, _)| k != "id") {
        merged.insert(k, v);
    }
    if merged.len() > 1 {
        agents.push(Value::Object(merged));
    }

    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())? + "\n";
    let catalog = load_catalog(BUILTIN_AGENTS_JSON, Some(&text));
    if let Some(error) = catalog.errors.into_iter().next() {
        return Err(error);
    }
    if !catalog.agents.iter().any(|a| a.id == id) {
        return Err(format!("Agent „{id}” nie istnieje"));
    }
    Ok(text)
}

/// Saves the settings in `<config dir>/agents.json`.
pub fn save_settings(config_dir: &Path, id: &str, settings: &AgentSettings) -> Result<(), String> {
    let path = config_dir.join("agents.json");
    let current = std::fs::read_to_string(&path).ok();
    let text = apply_settings(current.as_deref(), id, settings)?;
    std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("Nie można zapisać {}: {e}", path.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Nie można zapisać {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(
        args: &[&str],
        env: &[(&str, &str)],
        acp: Option<&[&str]>,
        hidden: bool,
    ) -> AgentSettings {
        AgentSettings {
            args: args.iter().map(|s| s.to_string()).collect(),
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            acp: acp.map(|a| a.iter().map(|s| s.to_string()).collect()),
            hidden,
        }
    }

    fn entry(text: &str, id: &str) -> Option<Value> {
        let v: Value = serde_json::from_str(text).unwrap();
        v["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == id)
            .cloned()
    }

    #[test]
    fn settings_become_an_override_and_keep_the_rest_of_the_file() {
        let user = r#"{ "$comment": "moje", "agents": [
            { "id": "codex", "commands": ["codex-beta"], "args": ["--old"] },
            { "id": "aider", "name": "Aider", "commands": ["aider"] }
        ] }"#;
        let s = settings(
            &["--model", "anthropic/claude sonnet"],
            &[("OPENCODE_CONFIG", "/home/me/oc.json")],
            Some(&["opencode", "acp", "--print-logs"]),
            false,
        );
        let text = apply_settings(Some(user), "opencode", &s).unwrap();
        let oc = entry(&text, "opencode").unwrap();
        assert_eq!(oc["args"], json!(["--model", "anthropic/claude sonnet"]));
        assert_eq!(oc["env"], json!({ "OPENCODE_CONFIG": "/home/me/oc.json" }));
        assert_eq!(
            oc["acp"],
            json!({ "command": "opencode", "args": ["acp", "--print-logs"] })
        );
        assert!(text.contains("\"$comment\": \"moje\""));
        assert_eq!(entry(&text, "aider").unwrap()["name"], "Aider");

        // Hand-written fields of an entry stay; the settings' own fields are replaced.
        let text = apply_settings(Some(&text), "codex", &settings(&[], &[], None, true)).unwrap();
        let codex = entry(&text, "codex").unwrap();
        assert_eq!(codex["commands"], json!(["codex-beta"]));
        assert_eq!(codex.get("args"), None);
        assert_eq!(codex["disabled"], true);
        let catalog = load_catalog(BUILTIN_AGENTS_JSON, Some(&text));
        assert!(
            catalog
                .agents
                .iter()
                .find(|a| a.id == "codex")
                .unwrap()
                .hidden
        );
    }

    #[test]
    fn defaults_remove_the_entry_and_the_built_in_conversation_command_is_not_copied() {
        let text = apply_settings(
            None,
            "gemini",
            &settings(&[], &[], Some(&["gemini", "--acp"]), false),
        )
        .unwrap();
        assert_eq!(
            entry(&text, "gemini"),
            None,
            "nothing differs from the built-in agent"
        );
        let text = apply_settings(None, "gemini", &settings(&["-y"], &[], None, false)).unwrap();
        let text = apply_settings(Some(&text), "gemini", &AgentSettings::default()).unwrap();
        assert_eq!(entry(&text, "gemini"), None);
    }

    #[test]
    fn invalid_settings_are_refused() {
        for bad in [
            settings(&["$(rm -rf ~)"], &[], None, false),
            settings(&[], &[("1BAD", "x")], None, false),
            settings(&[], &[("KEY", "a\nb")], None, false),
            settings(&[], &[], Some(&["opencode; rm", "acp"]), false),
        ] {
            assert!(apply_settings(None, "opencode", &bad).is_err(), "{bad:?}");
        }
        assert!(apply_settings(None, "nope", &settings(&["-x"], &[], None, false)).is_err());
        assert!(apply_settings(Some("[1, 2]"), "opencode", &AgentSettings::default()).is_err());
    }
}
