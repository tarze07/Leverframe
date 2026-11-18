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
pub(super) const LIST_TIMEOUT: Duration = Duration::from_secs(30);
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
    /// Docker through `ssh`: the connection failed.
    Ssh(String),
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
                "Brak uprawnień do Dockera. Na Linuksie (także na serwerze, gdy Docker jest przez SSH) dodaj użytkownika do grupy docker (sudo usermod -aG docker $USER) i zaloguj się ponownie.",
            ),
            Self::NoSuchObject(what) => write!(f, "Nie ma takiego obrazu ani kontenera: {what}"),
            Self::Ssh(m) => write!(
                f,
                "Połączenie SSH z serwerem Dockera nie działa: {m}. Logowanie musi działać bez pytania (klucz z profilu, agent SSH albo ~/.ssh/config), a host być w known_hosts."
            ),
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
    /// `ssh` command: `docker` runs on that host (no local CLI), see `remote::over_ssh`.
    ssh: Option<Vec<String>>,
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
            ssh: None,
        }
    }

    /// `docker` on an SSH host through this `ssh` command (from `remote::ssh_command`).
    pub fn via_ssh(mut self, ssh: Vec<String>) -> Self {
        self.ssh = Some(ssh);
        self
    }

    pub fn ssh(&self) -> Option<&[String]> {
        self.ssh.as_deref()
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

    /// The CLI with these arguments, output piped, no console window on Windows.
    pub(super) fn command(&self, args: &[&str]) -> Command {
        let mut command = match &self.ssh {
            Some(ssh) => {
                let words: Vec<String> = args.iter().map(|a| a.to_string()).collect();
                let (program, ssh_args) = super::remote::over_ssh(ssh, false, &words);
                let mut c = Command::new(program);
                c.args(ssh_args);
                c
            }
            None => {
                let mut c = Command::new(&self.program);
                c.args(args);
                c
            }
        };
        command
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
        command
    }

    pub(super) fn spawn_error(&self, e: std::io::Error) -> DockerError {
        if self.ssh.is_some() {
            return DockerError::Ssh(format!(
                "nie można uruchomić programu ssh ({e}) – zainstaluj klienta OpenSSH"
            ));
        }
        match e.kind() {
            std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied => {
                DockerError::NotInstalled(self.program.clone())
            }
            _ => DockerError::Other(format!("nie można uruchomić {}: {e}", self.program)),
        }
    }

    fn run(&self, args: &[&str], timeout: Duration) -> Result<Output, DockerError> {
        let timeout = self.timeout.unwrap_or(timeout);
        let mut child = self
            .command(args)
            .spawn()
            .map_err(|e| self.spawn_error(e))?;
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
    pub(super) fn ok(&self, args: &[&str], timeout: Duration) -> Result<String, DockerError> {
        let out = self.run(args, timeout)?;
        if out.success {
            Ok(out.stdout)
        } else {
            Err(self.classify(&out.stderr, out.code))
        }
    }

    /// [`classify`], and through `ssh` also its own failures (exit code 255) and a host
    /// without `docker` (127).
    pub(super) fn classify(&self, stderr: &str, code: Option<i32>) -> DockerError {
        if self.ssh.is_some() {
            let first = stderr
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("brak odpowiedzi");
            if code == Some(255) {
                return DockerError::Ssh(shorten(first));
            }
            if code == Some(127) || stderr.contains("docker: command not found") {
                return DockerError::Other(
                    "na serwerze nie ma programu docker (albo nie ma go w PATH dla połączeń ssh)"
                        .into(),
                );
            }
        }
        classify(stderr, code)
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
                        match self.classify(&out.stderr, out.code) {
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
