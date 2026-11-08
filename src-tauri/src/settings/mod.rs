//! SettingsService: application info and `settings.json` (default profile now; more in stage 7, #9).

mod store;

use serde::Serialize;

pub use store::{write_atomic, SettingsStore};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub os: String,
    pub arch: String,
}

impl AppInfo {
    pub fn current() -> Self {
        Self {
            name: env!("CARGO_PKG_NAME").to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
        }
    }
}

/// Basic application info shown in the status bar.
#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo::current()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_reports_package_and_platform() {
        let info = app_info();
        assert_eq!(info.name, "leverframe");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.os, std::env::consts::OS);
        assert!(!info.arch.is_empty());
    }

    #[test]
    fn app_info_serializes_all_fields() {
        let json = serde_json::to_value(AppInfo::current()).unwrap();
        for key in ["name", "version", "os", "arch"] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
    }
}

const PROJECT_DIR_KEY: &str = "projectDir";

/// Working directory for new agent terminals ("project folder").
#[tauri::command]
pub fn settings_project_dir(store: tauri::State<'_, SettingsStore>) -> Option<String> {
    store.get_string(PROJECT_DIR_KEY)
}

#[tauri::command]
pub fn settings_set_project_dir(
    store: tauri::State<'_, SettingsStore>,
    path: Option<String>,
) -> Result<Option<String>, String> {
    set_project_dir(&store, path)
}

pub fn set_project_dir(
    store: &SettingsStore,
    path: Option<String>,
) -> Result<Option<String>, String> {
    match path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        Some(p) => {
            if !std::path::Path::new(&p).is_dir() {
                return Err(format!("Folder „{p}” nie istnieje"));
            }
            store.set(PROJECT_DIR_KEY, serde_json::Value::String(p.clone()))?;
            Ok(Some(p))
        }
        None => {
            store.set(PROJECT_DIR_KEY, serde_json::Value::Null)?;
            Ok(None)
        }
    }
}

#[cfg(test)]
mod project_dir_tests {
    use super::*;

    #[test]
    fn sets_validates_and_clears_project_dir() {
        let dir = std::env::temp_dir().join(format!("lf-projdir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::new(&dir);
        let project = dir.to_string_lossy().into_owned();
        assert_eq!(
            set_project_dir(&store, Some(project.clone())).unwrap(),
            Some(project.clone())
        );
        assert_eq!(store.get_string(PROJECT_DIR_KEY), Some(project));
        assert!(set_project_dir(&store, Some("/definitely/missing/dir".into())).is_err());
        assert_eq!(set_project_dir(&store, None).unwrap(), None);
        assert_eq!(store.get_string(PROJECT_DIR_KEY), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

/// Everything in `settings.json`, for the UI (theme, fonts, keybindings, …).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub path: String,
    pub values: serde_json::Map<String, serde_json::Value>,
    /// Syntax error in the file, if any (values are then empty and saving is blocked).
    pub error: Option<String>,
}

pub fn snapshot(store: &SettingsStore) -> SettingsSnapshot {
    let (values, error) = match store.read() {
        Ok(v) => (v, None),
        Err(e) => (Default::default(), Some(e)),
    };
    SettingsSnapshot {
        path: store.path().to_string_lossy().into_owned(),
        values,
        error,
    }
}

/// Checks a value for a key the UI may change directly. Other keys have dedicated commands
/// (`projectDir`, `defaultProfile`, `recordSessions`) or are edited in the file.
pub fn validate_setting(key: &str, value: &serde_json::Value) -> Result<(), String> {
    use serde_json::Value;
    match (key, value) {
        ("theme", Value::String(s)) if ["dark", "light", "system"].contains(&s.as_str()) => Ok(()),
        ("theme", _) => Err("theme: dozwolone \"dark\", \"light\" lub \"system\"".into()),
        ("fontFamily", Value::String(s)) if !s.trim().is_empty() && s.len() <= 200 => Ok(()),
        ("fontFamily", _) => Err("fontFamily: niepusty tekst do 200 znaków".into()),
        ("fontSize", Value::Number(n)) if n.as_u64().is_some_and(|v| (8..=32).contains(&v)) => {
            Ok(())
        }
        ("fontSize", _) => Err("fontSize: liczba całkowita 8–32".into()),
        ("keybindings", Value::Object(m)) if m.values().all(|v| v.is_string() || v.is_null()) => {
            Ok(())
        }
        ("keybindings", _) => {
            Err("keybindings: obiekt { \"id.polecenia\": \"Ctrl+Shift+P\" | null }".into())
        }
        _ => Err(format!("Ustawienia „{key}” nie można zmienić w ten sposób")),
    }
}

#[tauri::command]
pub fn settings_read(store: tauri::State<'_, SettingsStore>) -> SettingsSnapshot {
    snapshot(&store)
}

#[tauri::command]
pub fn settings_update(
    store: tauri::State<'_, SettingsStore>,
    key: String,
    value: serde_json::Value,
) -> Result<SettingsSnapshot, String> {
    validate_setting(&key, &value)?;
    store.set(&key, value)?;
    Ok(snapshot(&store))
}

/// Creates an empty `settings.json` (so it can be opened in the editor) and returns its path.
#[tauri::command]
pub fn settings_ensure_file(store: tauri::State<'_, SettingsStore>) -> Result<String, String> {
    if !store.path().exists() {
        write_atomic(store.path(), "{\n}\n")?;
    }
    Ok(store.path().to_string_lossy().into_owned())
}

#[cfg(test)]
mod settings_command_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_ui_settings() {
        assert!(validate_setting("theme", &json!("light")).is_ok());
        assert!(validate_setting("theme", &json!("blue")).is_err());
        assert!(validate_setting("fontSize", &json!(14)).is_ok());
        assert!(validate_setting("fontSize", &json!(64)).is_err());
        assert!(validate_setting("fontSize", &json!(13.5)).is_err());
        assert!(validate_setting("fontFamily", &json!("  ")).is_err());
        assert!(validate_setting(
            "keybindings",
            &json!({ "palette.open": "Ctrl+K", "files.quickOpen": null })
        )
        .is_ok());
        assert!(validate_setting("keybindings", &json!({ "x": 1 })).is_err());
        assert!(
            validate_setting("projectDir", &json!("/etc")).is_err(),
            "has its own command with checks"
        );
    }

    #[test]
    fn snapshot_reports_errors() {
        let dir = std::env::temp_dir().join(format!("lf-snap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::new(&dir);
        store.set("theme", json!("light")).unwrap();
        let s = snapshot(&store);
        assert_eq!(s.values["theme"], "light");
        assert!(s.error.is_none());
        std::fs::write(store.path(), "{ oops").unwrap();
        let s = snapshot(&store);
        assert!(s.values.is_empty());
        assert!(s.error.unwrap().contains("settings.json"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
