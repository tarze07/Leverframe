//! Changing Docker: a new container for agents (its `docker run` arguments are built and shown
//! before it is created), start / stop / restart / remove, removing images and volumes.
//! Arguments go to the CLI as a list (no shell); every name is validated first.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::cli::{valid_reference, Docker, DockerError, LIST_TIMEOUT};
use super::model::LEVERFRAME_LABEL;

/// `docker stop` waits 10 s for the container before it kills it.
const STOP_TIMEOUT: Duration = Duration::from_secs(60);
/// Where the project folder is in a container.
pub const WORKSPACE: &str = "/workspace";

/// An environment variable of a new container.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

/// A container for agents as the "Nowy kontener" form describes it.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ContainerSpec {
    pub image: String,
    pub name: String,
    /// Folder on this machine mounted as `/workspace`.
    pub project_dir: Option<String>,
    /// A named volume for the home directory: the agents' logins survive the container.
    pub home_volume: bool,
    /// The home directory in the container (where the volume goes).
    pub home_dir: String,
    pub env: Vec<EnvVar>,
    /// `8080`, `8080:80`, `127.0.0.1:8080:80`, optionally `/tcp` or `/udp`.
    pub ports: Vec<String>,
    /// A Docker network by name (`host` is refused: it shares this machine's network).
    pub network: Option<String>,
    /// `agent`, `1000`, `1000:1000`.
    pub user: Option<String>,
}

/// What `docker run` will be, before it runs.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreatePlan {
    /// The `docker run` arguments, as they will be passed.
    pub args: Vec<String>,
    /// The same as a command line, for the user to read.
    pub command: String,
    /// The volume created for the home directory (with the Leverframe label), if any.
    pub volume: Option<String>,
    /// Things the user should know before creating it.
    pub warnings: Vec<String>,
}

/// Docker's rule for container and volume names.
pub fn valid_name(s: &str) -> bool {
    let mut chars = s.chars();
    s.len() <= 128
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

fn valid_env_name(s: &str) -> bool {
    let mut chars = s.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn valid_port(s: &str) -> bool {
    let (ports, proto) = s.split_once('/').unwrap_or((s, "tcp"));
    let parts: Vec<&str> = ports.split(':').collect();
    let port = |p: &str| p.parse::<u16>().is_ok_and(|n| n > 0);
    let ip = |p: &str| p.parse::<std::net::Ipv4Addr>().is_ok();
    matches!(proto, "tcp" | "udp")
        && match parts.as_slice() {
            [c] => port(c),
            [h, c] => port(h) && port(c),
            [i, h, c] => ip(i) && (h.is_empty() || port(h)) && port(c),
            _ => false,
        }
}

fn valid_user(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.:-".contains(c))
}

/// The home directory volume of a container: `leverframe-<name>-home`.
pub fn home_volume_name(container: &str) -> String {
    format!("leverframe-{container}-home")
}

fn is_home_or_root(dir: &Path) -> bool {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from);
    dir.parent().is_none() || home.is_some_and(|h| h == dir)
}

/// Owner (UID, GID) of a folder; `None` where Docker maps owners itself (Windows, macOS).
fn folder_owner(dir: &Path) -> Option<(u32, u32)> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::metadata(dir).ok()?;
        Some((m.uid(), m.gid()))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = dir;
        None
    }
}

/// UID of the user in the image with agents (`packaging/docker/agents/Dockerfile`).
const AGENTS_IMAGE_UID: u32 = 1000;

/// On Linux the container's user writes the project folder with its own UID: the image with
/// agents runs as UID 1000, so a folder of another user needs `-u <UID>:<GID>`.
fn owner_warning(image: &str, user: Option<&str>, owner: Option<(u32, u32)>) -> Option<String> {
    let (uid, gid) = owner?;
    let repository = image.rsplit('/').next().unwrap_or(image);
    if uid == AGENTS_IMAGE_UID || user.is_some() || !repository.starts_with("leverframe-agents") {
        return None;
    }
    Some(format!(
        "Folder projektu należy do użytkownika o UID {uid}, a agenci w obrazie Leverframe działają jako UID {AGENTS_IMAGE_UID} – polecenia w kontenerze nie zapiszą plików projektu. Wpisz w polu „Użytkownik” (Więcej): {uid}:{gid}."
    ))
}

/// Checks the form and builds `docker run`.
pub fn plan(spec: &ContainerSpec) -> Result<CreatePlan, String> {
    let image = spec.image.trim();
    if !valid_reference(image) {
        return Err("Podaj obraz, np. leverframe-agents:0.8.0".into());
    }
    let name = spec.name.trim();
    if !valid_name(name) {
        return Err("Nazwa kontenera: litery, cyfry, _ . -, zaczyna się literą lub cyfrą".into());
    }
    let mut args: Vec<String> = ["run", "-d", "--name", name, "--label"]
        .map(String::from)
        .to_vec();
    args.push(format!("{LEVERFRAME_LABEL}=1"));
    args.push("--init".into());
    let mut warnings = Vec::new();

    if let Some(dir) = spec
        .project_dir
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        let path = Path::new(dir);
        if !path.is_absolute() || !path.is_dir() {
            return Err(format!("Folder projektu nie istnieje: {dir}"));
        }
        if is_home_or_root(path) {
            warnings.push(format!(
                "Do kontenera trafi cały folder {dir} – agent będzie miał dostęp do wszystkich jego plików. Lepiej wybrać folder projektu."
            ));
        }
        let user = spec
            .user
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty());
        warnings.extend(owner_warning(image, user, folder_owner(path)));
        args.extend(["-v".into(), format!("{dir}:{WORKSPACE}")]);
    }
    let volume = spec.home_volume.then(|| home_volume_name(name));
    if let Some(volume) = &volume {
        let home = spec.home_dir.trim();
        if !home.starts_with('/') || home.contains(':') || home.contains(char::is_whitespace) {
            return Err("Katalog domowy w kontenerze: ścieżka bezwzględna, np. /home/agent".into());
        }
        args.extend(["-v".into(), format!("{volume}:{home}")]);
    }
    args.extend(["-w".into(), WORKSPACE.into()]);
    for var in &spec.env {
        let key = var.name.trim();
        if !valid_env_name(key) {
            return Err(format!("Nieprawidłowa nazwa zmiennej: {key}"));
        }
        if var.value.contains(['\n', '\r', '\0']) {
            return Err(format!("Wartość zmiennej {key} ma znak nowej linii"));
        }
        args.extend(["-e".into(), format!("{key}={}", var.value)]);
    }
    if !spec.env.is_empty() {
        warnings.push(
            "Zmienne środowiskowe są zapisane w konfiguracji kontenera i widoczne w docker inspect – klucze lepiej wpisać przy logowaniu agenta w terminalu.".into(),
        );
    }
    for port in spec
        .ports
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
    {
        if !valid_port(port) {
            return Err(format!(
                "Nieprawidłowy port: {port} (np. 8080 albo 8080:80)"
            ));
        }
        args.extend(["-p".into(), port.to_string()]);
    }
    if let Some(net) = spec
        .network
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        if net == "host" {
            return Err("Sieć host nie jest dostępna: kontener miałby sieć tego komputera.".into());
        }
        if !valid_name(net) {
            return Err(format!("Nieprawidłowa nazwa sieci: {net}"));
        }
        args.extend(["--network".into(), net.to_string()]);
    }
    if let Some(user) = spec
        .user
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        if !valid_user(user) {
            return Err(format!("Nieprawidłowy użytkownik: {user}"));
        }
        args.extend(["-u".into(), user.to_string()]);
    }
    // The container waits for terminals and agents (`docker exec`).
    args.extend([image.to_string(), "sleep".into(), "infinity".into()]);
    Ok(CreatePlan {
        command: display("docker", &args),
        args,
        volume,
        warnings,
    })
}

/// The command line shown to the user (quoted where needed).
pub fn display(program: &str, args: &[String]) -> String {
    std::iter::once(program.to_string())
        .chain(args.iter().map(|a| {
            if a.is_empty()
                || a.contains(|c: char| c.is_whitespace() || "'\"$`\\;&|<>()".contains(c))
            {
                format!("'{}'", a.replace('\'', r"'\''"))
            } else {
                a.clone()
            }
        }))
        .collect::<Vec<_>>()
        .join(" ")
}

fn checked<'a>(what: &str, reference: &'a str) -> Result<&'a str, DockerError> {
    if valid_reference(reference) {
        Ok(reference)
    } else {
        Err(DockerError::Other(format!(
            "nieprawidłowa nazwa {what}: {reference}"
        )))
    }
}

impl Docker {
    /// Creates the container (and its home volume, with the Leverframe label); its id.
    pub fn create(&self, spec: &ContainerSpec) -> Result<String, DockerError> {
        let plan = plan(spec).map_err(DockerError::Other)?;
        if let Some(volume) = &plan.volume {
            let label = format!("{LEVERFRAME_LABEL}=1");
            // Existing volumes are kept (a container made again keeps its logins).
            self.ok(
                &["volume", "create", "--label", &label, volume],
                LIST_TIMEOUT,
            )?;
        }
        let args: Vec<&str> = plan.args.iter().map(String::as_str).collect();
        let out = self.ok(&args, Duration::from_secs(120))?;
        Ok(out.trim().to_string())
    }

    pub fn start(&self, container: &str) -> Result<(), DockerError> {
        let c = checked("kontenera", container)?;
        self.ok(&["start", "--", c], STOP_TIMEOUT).map(|_| ())
    }

    pub fn stop(&self, container: &str) -> Result<(), DockerError> {
        let c = checked("kontenera", container)?;
        self.ok(&["stop", "--", c], STOP_TIMEOUT).map(|_| ())
    }

    pub fn restart(&self, container: &str) -> Result<(), DockerError> {
        let c = checked("kontenera", container)?;
        self.ok(&["restart", "--", c], STOP_TIMEOUT).map(|_| ())
    }

    /// Removes a container (`force`: also a running one). Named volumes stay.
    pub fn remove(&self, container: &str, force: bool) -> Result<(), DockerError> {
        let c = checked("kontenera", container)?;
        let args: &[&str] = if force {
            &["rm", "--force", "--", c]
        } else {
            &["rm", "--", c]
        };
        self.ok(args, STOP_TIMEOUT).map(|_| ())
    }

    pub fn remove_image(&self, image: &str) -> Result<(), DockerError> {
        let i = checked("obrazu", image)?;
        self.ok(&["rmi", "--", i], STOP_TIMEOUT).map(|_| ())
    }

    pub fn remove_volume(&self, volume: &str) -> Result<(), DockerError> {
        if !valid_name(volume) {
            return Err(DockerError::Other(format!(
                "nieprawidłowa nazwa wolumenu: {volume}"
            )));
        }
        self.ok(&["volume", "rm", "--", volume], STOP_TIMEOUT)
            .map(|_| ())
    }

    /// Removes images no container uses (`docker image prune --all`); what Docker says it freed.
    pub fn prune_images(&self) -> Result<String, DockerError> {
        let out = self.ok(
            &["image", "prune", "--all", "--force"],
            Duration::from_secs(300),
        )?;
        Ok(out
            .lines()
            .find(|l| l.starts_with("Total reclaimed space"))
            .map(|l| l.trim().to_string())
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_of_another_uid_needs_the_user_of_the_container() {
        let w = owner_warning("leverframe-agents:0.8.0", None, Some((1001, 1002))).unwrap();
        assert!(w.contains("UID 1001") && w.contains(": 1001:1002."), "{w}");
        assert!(
            owner_warning("ghcr.io/me/leverframe-agents-python:1", None, Some((0, 0))).is_some()
        );
        // The same UID, a user chosen, another image, or no owners (Docker Desktop): nothing.
        assert_eq!(
            owner_warning("leverframe-agents:0.8.0", None, Some((1000, 1000))),
            None
        );
        assert_eq!(
            owner_warning(
                "leverframe-agents:0.8.0",
                Some("1001:1002"),
                Some((1001, 1002))
            ),
            None
        );
        assert_eq!(owner_warning("node:22", None, Some((1001, 1002))), None);
        assert_eq!(owner_warning("leverframe-agents:0.8.0", None, None), None);
    }
}
