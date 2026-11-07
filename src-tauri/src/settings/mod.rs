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
