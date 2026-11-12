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
const RECENT_DIRS_KEY: &str = "recentProjectDirs";
const REMOTE_DIRS_KEY: &str = "remoteDirs";
const MAX_RECENT_DIRS: usize = 8;

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
            remember_recent_dir(store, &p)?;
            Ok(Some(p))
        }
        None => {
            store.set(PROJECT_DIR_KEY, serde_json::Value::Null)?;
            Ok(None)
        }
    }
}

fn string_list(value: Option<serde_json::Value>) -> Vec<String> {
    match value {
        Some(serde_json::Value::Array(items)) => items
            .into_iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        _ => Vec::new(),
    }
}

/// Puts a folder at the top of the recently used project folders.
fn remember_recent_dir(store: &SettingsStore, dir: &str) -> Result<(), String> {
    let mut list = string_list(store.get_value(RECENT_DIRS_KEY));
    list.retain(|d| d != dir);
    list.insert(0, dir.to_string());
    list.truncate(MAX_RECENT_DIRS);
    store.set(RECENT_DIRS_KEY, serde_json::json!(list))
}

/// Recently used project folders that still exist, most recent first.
pub fn recent_project_dirs(store: &SettingsStore) -> Vec<String> {
    string_list(store.get_value(RECENT_DIRS_KEY))
        .into_iter()
        .filter(|d| std::path::Path::new(d).is_dir())
        .collect()
}

#[tauri::command]
pub fn settings_recent_project_dirs(store: tauri::State<'_, SettingsStore>) -> Vec<String> {
    recent_project_dirs(&store)
}

/// Working directory for agents on an SSH host (per profile; it cannot be checked locally).
pub fn remote_dir(store: &SettingsStore, profile_id: &str) -> Option<String> {
    store
        .get_value(REMOTE_DIRS_KEY)?
        .get(profile_id)?
        .as_str()
        .map(String::from)
}

pub fn remote_dirs(store: &SettingsStore) -> serde_json::Map<String, serde_json::Value> {
    match store.get_value(REMOTE_DIRS_KEY) {
        Some(serde_json::Value::Object(m)) => {
            m.into_iter().filter(|(_, v)| v.is_string()).collect()
        }
        _ => Default::default(),
    }
}

pub fn set_remote_dir(
    store: &SettingsStore,
    profile_id: &str,
    path: Option<String>,
) -> Result<Option<String>, String> {
    let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &path {
        if p.len() > 500 || p.chars().any(char::is_control) {
            return Err("Katalog: jedna linia, do 500 znaków".into());
        }
    }
    let mut map = remote_dirs(store);
    match &path {
        Some(p) => map.insert(profile_id.to_string(), serde_json::Value::String(p.clone())),
        None => map.remove(profile_id),
    };
    store.set(REMOTE_DIRS_KEY, serde_json::Value::Object(map))?;
    Ok(path)
}

#[tauri::command]
pub fn settings_remote_dirs(
    store: tauri::State<'_, SettingsStore>,
) -> serde_json::Map<String, serde_json::Value> {
    remote_dirs(&store)
}

#[tauri::command]
pub fn settings_set_remote_dir(
    store: tauri::State<'_, SettingsStore>,
    profile_id: String,
    path: Option<String>,
) -> Result<Option<String>, String> {
    set_remote_dir(&store, &profile_id, path)
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

    #[test]
    fn remembers_recent_project_dirs() {
        let dir = std::env::temp_dir().join(format!("lf-settings-recent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let folders: Vec<String> = (0..10)
            .map(|i| {
                let d = dir.join(format!("p{i}"));
                std::fs::create_dir_all(&d).unwrap();
                d.to_string_lossy().into_owned()
            })
            .collect();
        let store = SettingsStore::new(&dir);
        for f in &folders {
            set_project_dir(&store, Some(f.clone())).unwrap();
        }
        set_project_dir(&store, Some(folders[5].clone())).unwrap();
        let recent = recent_project_dirs(&store);
        assert_eq!(recent.len(), MAX_RECENT_DIRS);
        assert_eq!(recent[0], folders[5], "most recent first, no duplicates");
        assert_eq!(recent[1], folders[9]);
        assert_eq!(recent.iter().filter(|d| **d == folders[5]).count(), 1);
        std::fs::remove_dir_all(&folders[9]).unwrap();
        assert!(
            !recent_project_dirs(&store).contains(&folders[9]),
            "deleted folders are not offered"
        );
        set_project_dir(&store, None).unwrap();
        assert_eq!(
            recent_project_dirs(&store)[0],
            folders[5],
            "clearing keeps the history"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stores_remote_dirs_per_profile() {
        let dir = std::env::temp_dir().join(format!("lf-settings-remote-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::new(&dir);
        assert_eq!(remote_dir(&store, "user-1"), None);
        assert_eq!(
            set_remote_dir(&store, "user-1", Some("  ~/projects/app ".into())).unwrap(),
            Some("~/projects/app".into())
        );
        set_remote_dir(&store, "user-2", Some("/srv/www".into())).unwrap();
        assert_eq!(
            remote_dir(&store, "user-1").as_deref(),
            Some("~/projects/app")
        );
        assert!(set_remote_dir(&store, "user-1", Some("a\nb".into())).is_err());
        assert_eq!(
            set_remote_dir(&store, "user-1", Some(" ".into())).unwrap(),
            None
        );
        assert_eq!(remote_dir(&store, "user-1"), None);
        assert_eq!(remote_dir(&store, "user-2").as_deref(), Some("/srv/www"));
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
        // Theme ids are defined by the UI (unknown ones fall back to the default theme there).
        ("theme" | "darkTheme" | "lightTheme", Value::String(s)) if is_theme_id(s) => Ok(()),
        ("theme", _) => {
            Err("theme: identyfikator motywu (np. \"dark\", \"light-paper\") lub \"system\"".into())
        }
        ("darkTheme" | "lightTheme", _) => Err(format!(
            "{key}: identyfikator motywu, np. \"dark-midnight\""
        )),
        ("autoSave", Value::String(s))
            if ["off", "afterDelay", "onFocusChange"].contains(&s.as_str()) =>
        {
            Ok(())
        }
        ("acpConfirmCommands", Value::Bool(_)) => Ok(()),
        ("acpConfirmCommands", _) => Err("acpConfirmCommands: true lub false".into()),
        ("autoSave", _) => Err("autoSave: \"off\", \"afterDelay\" lub \"onFocusChange\"".into()),
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

fn is_theme_id(s: &str) -> bool {
    (1..=40).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
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
        assert!(validate_setting("theme", &json!("system")).is_ok());
        assert!(validate_setting("theme", &json!("dark-midnight")).is_ok());
        assert!(validate_setting("theme", &json!("Blue Theme")).is_err());
        assert!(validate_setting("theme", &json!(1)).is_err());
        assert!(validate_setting("darkTheme", &json!("dark-plum")).is_ok());
        assert!(validate_setting("autoSave", &json!("afterDelay")).is_ok());
        assert!(validate_setting("acpConfirmCommands", &json!(false)).is_ok());
        assert!(validate_setting("acpConfirmCommands", &json!("no")).is_err());
        assert!(validate_setting("autoSave", &json!("always")).is_err());
        assert!(validate_setting("autoSave", &json!(true)).is_err());
        assert!(validate_setting("lightTheme", &json!("")).is_err());
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
