use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ProfileKind {
    Local,
    Wsl,
    Ssh,
    Powershell,
    /// A Docker container (`docker exec`): docs/DOCKER.md, § 4.2.
    Container,
}

/// Where a profile comes from: detected on this machine (read-only) or defined by the user (`profiles.json`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProfileSource {
    Detected,
    #[default]
    User,
}

/// Connection details of an SSH profile. Passwords are never stored: authentication goes through
/// keys / ssh-agent, or the password prompt of `ssh` itself inside the terminal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
}

impl SshTarget {
    /// Arguments for the system `ssh` client.
    pub fn args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(port) = self.port {
            args.extend(["-p".to_string(), port.to_string()]);
        }
        if let Some(key) = self.identity_file.as_deref().filter(|k| !k.is_empty()) {
            args.extend(["-i".to_string(), key.to_string()]);
        }
        let destination = match self.user.as_deref().filter(|u| !u.is_empty()) {
            Some(user) => format!("{user}@{}", self.host),
            None => self.host.clone(),
        };
        args.push(destination);
        args
    }

    pub fn validate(&self) -> Result<(), String> {
        let bad = |s: &str| {
            s.is_empty() || s.starts_with('-') || s.chars().any(|c| c.is_whitespace() || c == '@')
        };
        if bad(&self.host) {
            return Err("Nieprawidłowa nazwa hosta".into());
        }
        if self.port == Some(0) {
            return Err("Port musi być w zakresie 1–65535".into());
        }
        if let Some(user) = self.user.as_deref().filter(|u| !u.is_empty()) {
            if bad(user) {
                return Err("Nieprawidłowa nazwa użytkownika".into());
            }
        }
        Ok(())
    }
}

/// The container of a container profile and how its terminal starts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContainerTarget {
    /// Container name (or id).
    pub name: String,
    /// User in the container (`None`: the image's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// Shell to start (`None`, or missing in the container: bash, else sh).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    /// Working directory in the container (`None`: `/workspace`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workdir: Option<String>,
    /// Start the container when its terminal opens (otherwise the user is asked).
    #[serde(default = "yes")]
    pub auto_start: bool,
}

fn yes() -> bool {
    true
}

impl ContainerTarget {
    pub fn validate(&self) -> Result<(), String> {
        if !crate::docker::actions::valid_name(&self.name) {
            return Err("Nieprawidłowa nazwa kontenera".into());
        }
        if let Some(user) = &self.user {
            if user.is_empty()
                || user.starts_with('-')
                || !user
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_.:-".contains(c))
            {
                return Err("Nieprawidłowy użytkownik kontenera".into());
            }
        }
        for (what, path) in [("Powłoka", &self.shell), ("Katalog roboczy", &self.workdir)] {
            if let Some(p) = path {
                if !p.starts_with('/')
                    || p.contains(|c: char| c.is_whitespace() || c == '\'' || c == '\0')
                {
                    return Err(format!(
                        "{what}: ścieżka bezwzględna w kontenerze, np. /bin/bash"
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub kind: ProfileKind,
    /// Program to start. For SSH profiles with `ssh` set, defaults to `ssh`.
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Short extra info shown in the list (e.g. `user@host:22`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SshTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<ContainerTarget>,
    #[serde(default)]
    pub source: ProfileSource,
}

/// What is needed to start a profile in a PTY.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<String>,
}

impl Profile {
    pub fn launch_spec(&self) -> LaunchSpec {
        if let (Some(target), ProfileKind::Container) = (&self.container, self.kind) {
            // The program is the docker CLI from the settings (`resolve_request` puts it in).
            return LaunchSpec {
                program: "docker".into(),
                args: crate::docker::terminal::terminal_args(target, None),
                env: Vec::new(),
                cwd: None,
            };
        }
        let (program, args) = match (&self.ssh, self.kind) {
            (Some(target), ProfileKind::Ssh) => (
                if self.command.is_empty() {
                    "ssh".to_string()
                } else {
                    self.command.clone()
                },
                target.args(),
            ),
            _ => (self.command.clone(), self.args.clone()),
        };
        LaunchSpec {
            program,
            args,
            env: self
                .env
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            cwd: self.cwd.clone(),
        }
    }

    /// Normalises and checks a user-defined profile before it is saved.
    pub fn validate_user(&mut self) -> Result<(), String> {
        self.source = ProfileSource::User;
        self.name = self.name.trim().to_string();
        if let Some(target) = &mut self.ssh {
            target.host = target.host.trim().to_string();
            target.user = target
                .user
                .take()
                .map(|u| u.trim().to_string())
                .filter(|u| !u.is_empty());
            target.identity_file = target
                .identity_file
                .take()
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty());
            target.validate()?;
            self.kind = ProfileKind::Ssh;
            let port = target.port.map(|p| format!(":{p}")).unwrap_or_default();
            let user = target
                .user
                .as_deref()
                .map(|u| format!("{u}@"))
                .unwrap_or_default();
            self.description = Some(format!("{user}{}{port}", target.host));
            if self.name.is_empty() {
                self.name = target.host.clone();
            }
        } else if let Some(target) = &mut self.container {
            target.name = target.name.trim().to_string();
            for field in [&mut target.user, &mut target.shell, &mut target.workdir] {
                *field = field
                    .take()
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty());
            }
            target.validate()?;
            self.kind = ProfileKind::Container;
            self.description = Some(format!("kontener {}", target.name));
            if self.name.is_empty() {
                self.name = target.name.clone();
            }
        } else if self.command.trim().is_empty() {
            return Err("Podaj program do uruchomienia".into());
        }
        if self.name.is_empty() {
            return Err("Podaj nazwę profilu".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh_profile(target: SshTarget) -> Profile {
        Profile {
            id: "user-1".into(),
            name: String::new(),
            kind: ProfileKind::Ssh,
            command: String::new(),
            args: vec![],
            env: BTreeMap::new(),
            cwd: None,
            icon: None,
            description: None,
            ssh: Some(target),
            container: None,
            source: ProfileSource::User,
        }
    }

    #[test]
    fn builds_ssh_arguments() {
        let target = SshTarget {
            host: "example.com".into(),
            port: Some(2222),
            user: Some("dev".into()),
            identity_file: Some("~/.ssh/id_ed25519".into()),
        };
        assert_eq!(
            target.args(),
            ["-p", "2222", "-i", "~/.ssh/id_ed25519", "dev@example.com"]
        );
        let minimal = SshTarget {
            host: "srv".into(),
            ..Default::default()
        };
        assert_eq!(minimal.args(), ["srv"]);
    }

    #[test]
    fn ssh_launch_spec_uses_system_ssh() {
        let p = ssh_profile(SshTarget {
            host: "srv".into(),
            user: Some("me".into()),
            ..Default::default()
        });
        let spec = p.launch_spec();
        assert_eq!(spec.program, "ssh");
        assert_eq!(spec.args, ["me@srv"]);
    }

    #[test]
    fn validates_and_normalises_ssh_profiles() {
        let mut p = ssh_profile(SshTarget {
            host: "  example.com ".into(),
            port: Some(22),
            user: Some(" ".into()),
            identity_file: Some("".into()),
        });
        p.validate_user().unwrap();
        assert_eq!(p.name, "example.com");
        assert_eq!(p.description.as_deref(), Some("example.com:22"));
        let t = p.ssh.as_ref().unwrap();
        assert_eq!(
            (t.user.as_deref(), t.identity_file.as_deref()),
            (None, None)
        );
    }

    #[test]
    fn rejects_unsafe_ssh_values() {
        for host in ["", "-oProxyCommand=x", "a b", "user@host"] {
            let mut p = ssh_profile(SshTarget {
                host: host.into(),
                ..Default::default()
            });
            assert!(
                p.validate_user().is_err(),
                "host {host:?} should be rejected"
            );
        }
        let mut p = ssh_profile(SshTarget {
            host: "h".into(),
            port: Some(0),
            ..Default::default()
        });
        assert!(p.validate_user().is_err());
        let mut p = ssh_profile(SshTarget {
            host: "h".into(),
            user: Some("-x".into()),
            ..Default::default()
        });
        assert!(p.validate_user().is_err());
    }

    #[test]
    fn serializes_with_camel_case_and_lowercase_kind() {
        let p = ssh_profile(SshTarget {
            host: "h".into(),
            identity_file: Some("k".into()),
            ..Default::default()
        });
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["kind"], "ssh");
        assert_eq!(json["source"], "user");
        assert_eq!(json["ssh"]["identityFile"], "k");
    }

    #[test]
    fn container_profiles_are_checked_and_start_docker_exec() {
        let mut p: Profile = serde_json::from_str(
            r#"{"id":"","name":" ","kind":"local","container":{"name":" sklep-agenci ","user":"","shell":" /bin/zsh "}}"#,
        )
        .unwrap();
        p.validate_user().unwrap();
        assert_eq!(p.kind, ProfileKind::Container);
        assert_eq!(p.name, "sklep-agenci");
        assert_eq!(p.description.as_deref(), Some("kontener sklep-agenci"));
        let target = p.container.clone().unwrap();
        assert_eq!(
            (target.user, target.shell.as_deref()),
            (None, Some("/bin/zsh"))
        );
        assert!(target.auto_start, "starts the container by default");
        let spec = p.launch_spec();
        assert_eq!(spec.program, "docker");
        assert_eq!(spec.args[..2], ["exec", "-it"]);
        assert!(spec.args.contains(&"sklep-agenci".to_string()));

        let bad = |json: &str| {
            let mut p: Profile = serde_json::from_str(json).unwrap();
            p.validate_user().unwrap_err()
        };
        assert!(
            bad(r#"{"id":"","name":"x","kind":"container","container":{"name":"-x"}}"#)
                .contains("kontenera")
        );
        assert!(bad(r#"{"id":"","name":"x","kind":"container","container":{"name":"c","user":"--privileged"}}"#).contains("użytkownik"));
        assert!(bad(
            r#"{"id":"","name":"x","kind":"container","container":{"name":"c","shell":"bash"}}"#
        )
        .contains("Powłoka"));
        assert!(bad(
            r#"{"id":"","name":"x","kind":"container","container":{"name":"c","workdir":"/a b"}}"#
        )
        .contains("Katalog roboczy"));
    }
}
