use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::detect::detect_all;
use super::model::{Profile, ProfileKind, ProfileSource};
use crate::settings::{write_atomic, SettingsStore};

const DEFAULT_PROFILE_KEY: &str = "defaultProfile";

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProfilesFile {
    #[serde(default)]
    profiles: Vec<Profile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesState {
    pub profiles: Vec<Profile>,
    pub default_profile_id: Option<String>,
}

/// Detected profiles (cached; detection runs `wsl.exe`, reads `~/.ssh/config`, …) merged with
/// user profiles from `profiles.json`. The default profile id lives in `settings.json`.
pub struct ProfileService {
    profiles_path: PathBuf,
    settings: SettingsStore,
    detected: Mutex<Option<Vec<Profile>>>,
    detector: Box<dyn Fn() -> Vec<Profile> + Send + Sync>,
}

impl ProfileService {
    pub fn new(config_dir: &Path) -> Self {
        Self::with_detector(config_dir, detect_all)
    }

    pub fn with_detector(
        config_dir: &Path,
        detector: impl Fn() -> Vec<Profile> + Send + Sync + 'static,
    ) -> Self {
        Self {
            profiles_path: config_dir.join("profiles.json"),
            settings: SettingsStore::new(config_dir),
            detected: Mutex::new(None),
            detector: Box::new(detector),
        }
    }

    fn detected(&self) -> Vec<Profile> {
        let mut cache = self.detected.lock().unwrap();
        cache.get_or_insert_with(|| (self.detector)()).clone()
    }

    fn user_profiles(&self) -> Vec<Profile> {
        std::fs::read_to_string(&self.profiles_path)
            .ok()
            .and_then(|s| serde_json::from_str::<ProfilesFile>(&s).ok())
            .map(|f| f.profiles)
            .unwrap_or_default()
            .into_iter()
            .map(|mut p| {
                p.source = ProfileSource::User;
                p
            })
            .collect()
    }

    fn write_user_profiles(&self, profiles: Vec<Profile>) -> Result<(), String> {
        let json =
            serde_json::to_string_pretty(&ProfilesFile { profiles }).map_err(|e| e.to_string())?;
        write_atomic(&self.profiles_path, &(json + "\n"))
    }

    pub fn all(&self) -> Vec<Profile> {
        let mut all = self.detected();
        all.extend(self.user_profiles());
        all
    }

    pub fn state(&self) -> ProfilesState {
        let profiles = self.all();
        let default_profile_id =
            default_profile_id(&profiles, self.settings.get_string(DEFAULT_PROFILE_KEY));
        ProfilesState {
            profiles,
            default_profile_id,
        }
    }

    /// Re-runs detection (after installing a WSL distro, editing `~/.ssh/config`, …).
    pub fn refresh(&self) -> ProfilesState {
        *self.detected.lock().unwrap() = None;
        self.state()
    }

    pub fn resolve(&self, id: &str) -> Option<Profile> {
        self.all().into_iter().find(|p| p.id == id)
    }

    pub fn default_profile(&self) -> Option<Profile> {
        let state = self.state();
        let id = state.default_profile_id?;
        state.profiles.into_iter().find(|p| p.id == id)
    }

    /// Creates or updates a user profile. Returns the stored profile (with its id).
    pub fn save(&self, mut profile: Profile) -> Result<Profile, String> {
        profile.validate_user()?;
        let mut users = self.user_profiles();
        if profile.id.is_empty() || !profile.id.starts_with("user-") {
            profile.id = new_user_id();
        }
        match users.iter_mut().find(|p| p.id == profile.id) {
            Some(existing) => *existing = profile.clone(),
            None => users.push(profile.clone()),
        }
        self.write_user_profiles(users)?;
        Ok(profile)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut users = self.user_profiles();
        let before = users.len();
        users.retain(|p| p.id != id);
        if users.len() == before {
            return Err("Można usuwać tylko własne profile".into());
        }
        self.write_user_profiles(users)
    }

    pub fn set_default(&self, id: &str) -> Result<(), String> {
        if self.resolve(id).is_none() {
            return Err(format!("Profil {id} nie istnieje"));
        }
        self.settings.set(
            DEFAULT_PROFILE_KEY,
            serde_json::Value::String(id.to_string()),
        )
    }
}

fn new_user_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("user-{nanos:x}")
}

/// The configured default if it still exists; otherwise PowerShell on Windows / the login shell elsewhere.
pub fn default_profile_id(profiles: &[Profile], configured: Option<String>) -> Option<String> {
    if let Some(id) = configured.filter(|id| profiles.iter().any(|p| &p.id == id)) {
        return Some(id);
    }
    let preferred = if cfg!(windows) {
        ProfileKind::Powershell
    } else {
        ProfileKind::Local
    };
    profiles
        .iter()
        .find(|p| p.kind == preferred)
        .or_else(|| profiles.first())
        .map(|p| p.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::model::SshTarget;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn profile(id: &str, kind: ProfileKind) -> Profile {
        Profile {
            id: id.into(),
            name: id.into(),
            kind,
            command: "/bin/sh".into(),
            args: vec![],
            env: BTreeMap::new(),
            cwd: None,
            icon: None,
            description: None,
            ssh: None,
            source: ProfileSource::Detected,
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lf-profiles-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn service(dir: &Path) -> ProfileService {
        ProfileService::with_detector(dir, || {
            vec![
                profile("local:bash", ProfileKind::Local),
                profile("powershell:pwsh", ProfileKind::Powershell),
            ]
        })
    }

    #[test]
    fn caches_detection_until_refresh() {
        let dir = temp_dir("cache");
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let svc = ProfileService::with_detector(&dir, move || {
            counter.fetch_add(1, Ordering::SeqCst);
            vec![]
        });
        svc.state();
        svc.state();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        svc.refresh();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn saves_updates_and_deletes_user_profiles() {
        let dir = temp_dir("crud");
        let svc = service(&dir);
        let mut new = profile("", ProfileKind::Ssh);
        new.name = "Prod".into();
        new.ssh = Some(SshTarget {
            host: "prod.example.com".into(),
            port: Some(22),
            ..Default::default()
        });
        let saved = svc.save(new).unwrap();
        assert!(saved.id.starts_with("user-"));
        assert_eq!(saved.source, ProfileSource::User);

        let mut edited = saved.clone();
        edited.name = "Produkcja".into();
        svc.save(edited).unwrap();
        let users: Vec<_> = svc
            .all()
            .into_iter()
            .filter(|p| p.source == ProfileSource::User)
            .collect();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].name, "Produkcja");

        // Survives a restart (new service, same directory).
        assert!(service(&dir).resolve(&saved.id).is_some());

        assert!(
            svc.delete("local:bash").is_err(),
            "detected profiles cannot be deleted"
        );
        svc.delete(&saved.id).unwrap();
        assert!(svc.resolve(&saved.id).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_invalid_profiles() {
        let dir = temp_dir("invalid");
        let svc = service(&dir);
        let mut bad = profile("", ProfileKind::Ssh);
        bad.ssh = Some(SshTarget {
            host: "-oProxyCommand=evil".into(),
            ..Default::default()
        });
        assert!(svc.save(bad).is_err());
        assert!(!dir.join("profiles.json").exists());
    }

    #[test]
    fn default_profile_is_configurable_and_falls_back() {
        let dir = temp_dir("default");
        let svc = service(&dir);
        let expected = if cfg!(windows) {
            "powershell:pwsh"
        } else {
            "local:bash"
        };
        assert_eq!(svc.state().default_profile_id.as_deref(), Some(expected));

        svc.set_default("powershell:pwsh").unwrap();
        assert_eq!(svc.default_profile().unwrap().id, "powershell:pwsh");
        assert!(svc.set_default("missing").is_err());

        // A configured profile that disappeared falls back to the platform default.
        assert_eq!(
            default_profile_id(
                &[profile("local:zsh", ProfileKind::Local)],
                Some("gone".into())
            )
            .as_deref(),
            Some("local:zsh")
        );
        assert_eq!(default_profile_id(&[], None), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
