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

    /// Parsed settings. A missing file is empty settings; a file with a syntax error is an error
    /// (with line and column), so it is never silently overwritten.
    pub fn read(&self) -> Result<Map<String, Value>, String> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
            Err(e) => return Err(format!("Nie można odczytać {}: {e}", self.path.display())),
        };
        if text.trim().is_empty() {
            return Ok(Map::new());
        }
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(m)) => Ok(m),
            Ok(_) => Err("settings.json musi zawierać obiekt JSON ({ … })".into()),
            Err(e) => Err(format!(
                "Błąd w settings.json (wiersz {}, kolumna {}): {e}",
                e.line(),
                e.column()
            )),
        }
    }

    /// Settings for reading single values: a broken file behaves like empty settings.
    fn load(&self) -> Map<String, Value> {
        self.read().unwrap_or_default()
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

    /// Sets one key, keeping all others. Refuses to write while the file has a syntax error.
    pub fn set(&self, key: &str, value: Value) -> Result<(), String> {
        let mut map = self.read()?;
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
    fn broken_files_are_reported_and_never_overwritten() {
        let dir = std::env::temp_dir().join(format!("lf-settings-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::new(&dir);
        std::fs::write(store.path(), "{\n  \"theme\": \"light\",\n}").unwrap();
        assert_eq!(
            store.get_string("theme"),
            None,
            "reading single values tolerates the error"
        );
        let err = store.read().unwrap_err();
        assert!(err.contains("wiersz 3"), "{err}");
        assert!(store.set("defaultProfile", json!("x")).is_err());
        assert!(
            std::fs::read_to_string(store.path())
                .unwrap()
                .contains("\"light\""),
            "user's file kept"
        );
        std::fs::write(store.path(), "[]").unwrap();
        assert!(store.read().is_err());
        std::fs::write(store.path(), "  ").unwrap();
        assert!(store.read().unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
