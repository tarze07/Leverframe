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
