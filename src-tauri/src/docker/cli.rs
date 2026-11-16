//! Running the `docker` CLI: arguments as a list (no shell), a time limit, and Docker's errors
//! turned into messages the user can act on.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::model::{
    parse_containers, parse_images, parse_inspect, parse_version, parse_volumes, shorten,
    ContainerDetails, DockerContainer, DockerImage, DockerInfo, DockerVolume, LEVERFRAME_LABEL,
};

/// `docker version` may wait for Docker Desktop that is still starting.
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const JSON: &str = "{{json .}}";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DockerError {
    /// The program could not be started.
    NotInstalled(String),
    /// The daemon does not answer.
    NotRunning,
    /// No access to the daemon's socket.
    PermissionDenied,
    /// No such image or container.
    NoSuchObject(String),
    Timeout(u64),
    Other(String),
}

impl std::fmt::Display for DockerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotInstalled(program) => write!(
                f,
                "Nie znaleziono programu „{program}”. Zainstaluj Docker Desktop (Windows) albo Docker Engine (Linux), lub podaj ścieżkę do programu w ustawieniach (dockerPath)."
            ),
            Self::NotRunning => f.write_str(
                "Docker nie działa – uruchom Docker Desktop (Windows) albo usługę docker (Linux: sudo systemctl start docker).",
            ),
            Self::PermissionDenied => f.write_str(
                "Brak uprawnień do Dockera. Na Linuksie dodaj użytkownika do grupy docker (sudo usermod -aG docker $USER) i zaloguj się ponownie.",
            ),
            Self::NoSuchObject(what) => write!(f, "Nie ma takiego obrazu ani kontenera: {what}"),
            Self::Timeout(s) => write!(f, "Docker nie odpowiedział w ciągu {s} s"),
            Self::Other(m) => write!(f, "Docker: {m}"),
        }
    }
}

impl From<DockerError> for String {
    fn from(e: DockerError) -> String {
        e.to_string()
    }
}

/// What Docker's error output means.
pub fn classify(stderr: &str, code: Option<i32>) -> DockerError {
    let lower = stderr.to_lowercase();
    if lower.contains("permission denied") && lower.contains("docker") {
        DockerError::PermissionDenied
    } else if lower.contains("cannot connect to the docker daemon")
        || lower.contains("is the docker daemon running")
        || lower.contains("error during connect")
        || lower.contains("docker desktop is not running")
        || lower.contains("the system cannot find the file specified")
    {
        DockerError::NotRunning
    } else if let Some(i) = lower.find("no such ") {
        let what = stderr[i..].lines().next().unwrap_or_default();
        let name = what.split_once(':').map_or(what, |(_, n)| n).trim();
        DockerError::NoSuchObject(name.to_string())
    } else {
        let first = stderr.lines().map(str::trim).find(|l| !l.is_empty());
        DockerError::Other(match (first, code) {
            (Some(line), _) => shorten(line),
            (None, Some(c)) => format!("zakończył się kodem {c}"),
            (None, None) => "przerwany".into(),
        })
    }
}

/// Names of containers and images given to the CLI: no options (`-…`), no spaces or control
/// characters.
pub fn valid_reference(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.:/@-".contains(c))
}

/// The `docker` CLI (program from the settings, `docker` by default).
#[derive(Debug, Clone)]
pub struct Docker {
    program: String,
    /// Extra environment of the CLI (tests choose the fake's scenario with it).
    env: Vec<(String, String)>,
    /// Replaces the time limits (tests).
    timeout: Option<Duration>,
}

struct Output {
    stdout: String,
    stderr: String,
    success: bool,
    code: Option<i32>,
}

impl Docker {
    pub fn new(program: impl Into<String>) -> Self {
        let program = program.into();
        Self {
            program: if program.trim().is_empty() {
                "docker".into()
            } else {
                program
            },
            env: Vec::new(),
            timeout: None,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn with_env(mut self, key: &str, value: &str) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    pub fn program(&self) -> &str {
        &self.program
    }

    fn run(&self, args: &[&str], timeout: Duration) -> Result<Output, DockerError> {
        let timeout = self.timeout.unwrap_or(timeout);
        let mut command = Command::new(&self.program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in &self.env {
            command.env(k, v);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied => {
                DockerError::NotInstalled(self.program.clone())
            }
            _ => DockerError::Other(format!("nie można uruchomić {}: {e}", self.program)),
        })?;
        let read = |mut pipe: Box<dyn Read + Send>| {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = pipe.read_to_end(&mut buf);
                String::from_utf8_lossy(&buf).into_owned()
            })
        };
        let stdout = read(Box::new(child.stdout.take().expect("piped stdout")));
        let stderr = read(Box::new(child.stderr.take().expect("piped stderr")));
        let start = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if start.elapsed() > timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(DockerError::Timeout(timeout.as_secs()));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(e) => return Err(DockerError::Other(e.to_string())),
            }
        };
        Ok(Output {
            stdout: stdout.join().unwrap_or_default(),
            stderr: stderr.join().unwrap_or_default(),
            success: status.success(),
            code: status.code(),
        })
    }

    /// Runs a command that must succeed; its standard output.
    fn ok(&self, args: &[&str], timeout: Duration) -> Result<String, DockerError> {
        let out = self.run(args, timeout)?;
        if out.success {
            Ok(out.stdout)
        } else {
            Err(classify(&out.stderr, out.code))
        }
    }

    /// Whether Docker can be used. Never fails: what is wrong is in `message`.
    pub fn info(&self) -> DockerInfo {
        match self.run(&["version", "--format", JSON], VERSION_TIMEOUT) {
            Ok(out) => {
                let (client, server, os) = parse_version(&out.stdout);
                let running = out.success && server.is_some();
                DockerInfo {
                    installed: true,
                    running,
                    client_version: client,
                    server_version: server,
                    server_os: os,
                    message: (!running).then(|| {
                        match classify(&out.stderr, out.code) {
                            // `version` succeeded without a server part: say it is not running.
                            DockerError::Other(_) if out.success => DockerError::NotRunning,
                            e => e,
                        }
                        .to_string()
                    }),
                }
            }
            Err(e) => DockerInfo {
                installed: !matches!(e, DockerError::NotInstalled(_)),
                message: Some(e.to_string()),
                ..Default::default()
            },
        }
    }

    pub fn images(&self) -> Result<Vec<DockerImage>, DockerError> {
        let all = self.ok(&["images", "--format", JSON], LIST_TIMEOUT)?;
        let filter = format!("label={LEVERFRAME_LABEL}=1");
        let ours = self.ok(
            &["images", "--filter", &filter, "--format", "{{.ID}}"],
            LIST_TIMEOUT,
        )?;
        let ids: Vec<String> = ours.lines().map(|l| l.trim().to_string()).collect();
        parse_images(&all, &ids).map_err(DockerError::Other)
    }

    /// All containers, also stopped ones.
    pub fn containers(&self) -> Result<Vec<DockerContainer>, DockerError> {
        let out = self.ok(
            &["ps", "--all", "--no-trunc", "--format", JSON],
            LIST_TIMEOUT,
        )?;
        parse_containers(&out).map_err(DockerError::Other)
    }

    pub fn volumes(&self) -> Result<Vec<DockerVolume>, DockerError> {
        let out = self.ok(&["volume", "ls", "--format", JSON], LIST_TIMEOUT)?;
        parse_volumes(&out).map_err(DockerError::Other)
    }

    /// Details of a container (by name or id).
    pub fn inspect(&self, container: &str) -> Result<ContainerDetails, DockerError> {
        if !valid_reference(container) {
            return Err(DockerError::Other(format!(
                "nieprawidłowa nazwa kontenera: {}",
                shorten(container)
            )));
        }
        let out = self.ok(
            &["inspect", "--type", "container", "--", container],
            LIST_TIMEOUT,
        )?;
        parse_inspect(&out).map_err(DockerError::Other)
    }
}
