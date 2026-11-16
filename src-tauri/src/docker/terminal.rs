//! Terminals in containers (D3, #65): the `docker exec` of a container profile, the project
//! folder as a path in the container (through the container's mounts), starting a stopped
//! container before its terminal opens, and containers made for Leverframe as detected profiles.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use super::actions::WORKSPACE;
use super::cli::{Docker, DockerError};
use super::model::ContainerMount;
use crate::profiles::{ContainerTarget, Profile, ProfileKind, ProfileSource};

/// Detection runs when the profile list is built: it must not wait long for Docker.
const DETECT_TIMEOUT: Duration = Duration::from_secs(5);

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `docker exec` arguments of a container profile's terminal. The shell is the profile's when
/// the container has it, else bash, else sh – started as a login shell. `workdir` (the project
/// folder in the container) replaces the profile's working directory.
pub fn terminal_args(target: &ContainerTarget, workdir: Option<&str>) -> Vec<String> {
    let dir = workdir
        .or(target.workdir.as_deref())
        .unwrap_or(WORKSPACE)
        .to_string();
    let mut args: Vec<String> = ["exec", "-it", "-w"].map(String::from).to_vec();
    args.push(dir);
    // The terminal's capabilities (docker exec gives TERM=xterm otherwise).
    args.extend(["-e", "TERM=xterm-256color", "-e", "COLORTERM=truecolor"].map(String::from));
    if let Some(user) = &target.user {
        args.extend(["-u".into(), user.clone()]);
    }
    let script = format!(
        "s={}; [ -x \"$s\" ] || s=$(command -v bash || command -v sh); exec \"$s\" -l",
        sh_quote(target.shell.as_deref().unwrap_or("/bin/bash"))
    );
    args.extend([
        "--".into(),
        target.name.clone(),
        "sh".into(),
        "-c".into(),
        script,
    ]);
    args
}

/// Lexically normalised absolute path (`.` and `..` resolved), for comparing folders.
fn normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Docker Desktop on Windows reports bind sources as `C:\…` or `/run/desktop/mnt/host/c/…`.
pub fn source_on_this_machine(source: &str) -> PathBuf {
    let lower = source.to_ascii_lowercase();
    for prefix in ["/run/desktop/mnt/host/", "/host_mnt/"] {
        if lower.starts_with(prefix) {
            let rest = &source[prefix.len()..];
            if let Some((drive, tail)) = rest.split_once('/') {
                if drive.len() == 1 && cfg!(windows) {
                    return PathBuf::from(format!(
                        "{}:\\{}",
                        drive.to_uppercase(),
                        tail.replace('/', "\\")
                    ));
                }
            }
        }
    }
    PathBuf::from(source)
}

/// A folder of this machine as a path in the container, when a bind mount contains it (the
/// deepest one wins). `None`: the folder is not in the container.
pub fn container_dir(mounts: &[ContainerMount], local: &Path) -> Option<String> {
    let local = normalise(local);
    mounts
        .iter()
        .filter(|m| m.kind == "bind")
        .filter_map(|m| {
            let source = normalise(&source_on_this_machine(&m.source));
            let rest = local.strip_prefix(&source).ok()?;
            let mut dir = m.destination.trim_end_matches('/').to_string();
            for part in rest.components() {
                dir.push('/');
                dir.push_str(&part.as_os_str().to_string_lossy());
            }
            Some((
                source.components().count(),
                if dir.is_empty() { "/".into() } else { dir },
            ))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, dir)| dir)
}

/// A path in the container as a path on this machine, when a bind mount contains it (the deepest
/// one wins). `None`: the path is only in the container (or in a volume).
pub fn host_path(mounts: &[ContainerMount], container_path: &str) -> Option<PathBuf> {
    if !container_path.starts_with('/') {
        return None;
    }
    let path = normalise(Path::new(container_path));
    let path: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(p) => Some(p.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    mounts
        .iter()
        .filter(|m| m.kind == "bind")
        .filter_map(|m| {
            let dest: Vec<&str> = m.destination.split('/').filter(|s| !s.is_empty()).collect();
            if path.len() < dest.len() || path.iter().zip(&dest).any(|(a, b)| a != b) {
                return None;
            }
            let mut local = source_on_this_machine(&m.source);
            for part in &path[dest.len()..] {
                local.push(part);
            }
            Some((dest.len(), local))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, p)| p)
}

/// `docker exec` arguments running `script` with `sh -c` in the container: `-i` keeps stdin open
/// (the ACP agent's pipes), `tty` adds a terminal (an agent's commands). `workdir` is a path in
/// the container.
pub fn exec_sh_args(
    name: &str,
    user: Option<&str>,
    workdir: Option<&str>,
    tty: bool,
    script: String,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["exec".into(), if tty { "-it" } else { "-i" }.into()];
    if let Some(dir) = workdir {
        args.extend(["-w".into(), dir.to_string()]);
    }
    if tty {
        args.extend(["-e", "TERM=xterm-256color", "-e", "COLORTERM=truecolor"].map(String::from));
    }
    if let Some(user) = user {
        args.extend(["-u".into(), user.to_string()]);
    }
    args.extend([
        "--".into(),
        name.to_string(),
        "sh".into(),
        "-c".into(),
        script,
    ]);
    args
}

/// What the terminal of a container profile needs before it starts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedContainer {
    /// The container runs now.
    pub running: bool,
    /// It was started for this terminal.
    pub started: bool,
    /// Working directory in the container: the project folder when it is mounted, else the
    /// profile's.
    pub workdir: String,
    /// The container's mounts (paths in the container as files of this machine).
    pub mounts: Vec<ContainerMount>,
}

impl Docker {
    /// Checks the container of a profile, starts it when it is stopped and `start` is true,
    /// and finds the project folder in it. A stopped container that may not be started yet
    /// comes back with `running: false` (the UI asks the user).
    pub fn prepare(
        &self,
        target: &ContainerTarget,
        project_dir: Option<&Path>,
        start: bool,
    ) -> Result<PreparedContainer, DockerError> {
        let details = self.inspect(&target.name)?;
        let mounts = details.mounts.clone();
        let workdir = project_dir
            .and_then(|d| container_dir(&details.mounts, d))
            .or_else(|| target.workdir.clone())
            .unwrap_or_else(|| WORKSPACE.into());
        if details.running {
            return Ok(PreparedContainer {
                running: true,
                started: false,
                workdir,
                mounts,
            });
        }
        if !start {
            return Ok(PreparedContainer {
                running: false,
                started: false,
                workdir,
                mounts,
            });
        }
        self.start(&target.name)?;
        Ok(PreparedContainer {
            running: true,
            started: true,
            workdir,
            mounts,
        })
    }

    /// Containers made for Leverframe (label `io.leverframe.agents=1`) as profiles – running or
    /// not (their terminal starts them). Nothing when Docker is missing or not running.
    pub fn detect_profiles(&self) -> Vec<Profile> {
        let docker = self.clone().with_timeout(DETECT_TIMEOUT);
        let Ok(containers) = docker.containers() else {
            return Vec::new();
        };
        containers
            .into_iter()
            .filter(|c| c.leverframe)
            .map(|c| Profile {
                id: format!("container:{}", c.name),
                name: c.name.clone(),
                kind: ProfileKind::Container,
                command: String::new(),
                args: Vec::new(),
                env: Default::default(),
                cwd: None,
                icon: None,
                // The image only: the state changes after detection (the view "Kontenery" shows it).
                description: Some(c.image.clone()),
                ssh: None,
                container: Some(ContainerTarget {
                    name: c.name,
                    auto_start: true,
                    ..Default::default()
                }),
                source: ProfileSource::Detected,
            })
            .collect()
    }
}
