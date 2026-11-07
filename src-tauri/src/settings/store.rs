use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// Writes a file atomically (temp file + rename), creating parent directories.
pub fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Nie można utworzyć {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents)
        .map_err(|e| format!("Nie można zapisać {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Nie można zapisać {}: {e}", path.display()))
}

/// `settings.json` in the app config directory. Unknown keys are preserved, so the file can be
/// edited by hand and extended by later stages (#9).
#[derive(Debug, Clone)]
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            path: config_dir.join("settings.json"),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn load(&self) -> Map<String, Value> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| match v {
                Value::Object(m) => Some(m),
                _ => None,
            })
            .unwrap_or_default()
    }

    pub fn get_value(&self, key: &str) -> Option<Value> {
        self.load().remove(key)
    }

    pub fn get_string(&self, key: &str) -> Option<String> {
        self.load()
            .get(key)
            .and_then(Value::as_str)
            .map(String::from)
    }

    pub fn set(&self, key: &str, value: Value) -> Result<(), String> {
        let mut map = self.load();
        map.insert(key.to_string(), value);
        let json = serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
        write_atomic(&self.path, &(json + "\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_unknown_keys() {
        let dir = std::env::temp_dir().join(format!("lf-settings-{}", std::process::id()));
        let store = SettingsStore::new(&dir);
        assert_eq!(store.get_string("defaultProfile"), None);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(store.path(), r#"{ "custom": 1 }"#).unwrap();
        store.set("defaultProfile", json!("local:bash")).unwrap();
        assert_eq!(
            store.get_string("defaultProfile").as_deref(),
            Some("local:bash")
        );
        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(store.path()).unwrap()).unwrap();
        assert_eq!(raw["custom"], 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tolerates_broken_files() {
        let dir = std::env::temp_dir().join(format!("lf-settings-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::new(&dir);
        std::fs::write(store.path(), "not json").unwrap();
        assert_eq!(store.get_string("defaultProfile"), None);
        store.set("defaultProfile", json!("x")).unwrap();
        assert_eq!(store.get_string("defaultProfile").as_deref(), Some("x"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
