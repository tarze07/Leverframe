//! Long Docker commands whose output the UI follows: `pull`, `build`, `logs --follow`. Each runs
//! as a job: its output arrives line by line, its end with a result, and it can be stopped.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::cli::{valid_reference, Docker, DockerError};

const ERROR_TAIL: usize = 20;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JobEvent {
    /// A line of the command's output (standard output or errors).
    Line { text: String },
    /// The command ended; `message` says what went wrong.
    Done { ok: bool, message: Option<String> },
}

pub trait JobEvents: Send + Sync + 'static {
    fn emit(&self, event: JobEvent);
}

struct Running {
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
}

/// Running jobs by id (application state).
#[derive(Default)]
pub struct DockerJobs {
    next: AtomicU64,
    running: Arc<Mutex<HashMap<u64, Running>>>,
}

fn read_lines(
    pipe: impl Read + Send + 'static,
    events: Arc<dyn JobEvents>,
    tail: Option<Arc<Mutex<VecDeque<String>>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut buf = Vec::new();
        // Progress of `pull` may use carriage returns instead of new lines.
        while reader
            .read_until(b'\n', &mut buf)
            .map(|n| n > 0)
            .unwrap_or(false)
        {
            for part in String::from_utf8_lossy(&buf).split('\r') {
                let text = part.trim_end().to_string();
                if text.is_empty() {
                    continue;
                }
                if let Some(tail) = &tail {
                    let mut t = tail.lock().unwrap();
                    t.push_back(text.clone());
                    if t.len() > ERROR_TAIL {
                        t.pop_front();
                    }
                }
                events.emit(JobEvent::Line { text });
            }
            buf.clear();
        }
    })
}

impl DockerJobs {
    /// Starts `docker <args>`; output and end go to `events`. Returns the job id.
    pub fn start(
        &self,
        docker: &Docker,
        args: &[String],
        events: Arc<dyn JobEvents>,
    ) -> Result<u64, DockerError> {
        self.start_with_input(docker, args, None, events)
    }

    /// [`start`](Self::start) with `input` written to the command's standard input (e.g. a
    /// build context for `docker build -`).
    pub fn start_with_input(
        &self,
        docker: &Docker,
        args: &[String],
        input: Option<Vec<u8>>,
        events: Arc<dyn JobEvents>,
    ) -> Result<u64, DockerError> {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut command = docker.command(&refs);
        if input.is_some() {
            command.stdin(std::process::Stdio::piped());
        }
        let mut child = command.spawn().map_err(|e| docker.spawn_error(e))?;
        if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
            std::thread::spawn(move || {
                use std::io::Write;
                // Closing stdin (drop) ends the input; a killed process just fails the write.
                let _ = stdin.write_all(&input);
            });
        }
        let docker = docker.clone();
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let tail = Arc::new(Mutex::new(VecDeque::new()));
        let out_reader = read_lines(stdout, events.clone(), None);
        let err_reader = read_lines(stderr, events.clone(), Some(tail.clone()));

        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let child = Arc::new(Mutex::new(child));
        let cancelled = Arc::new(AtomicBool::new(false));
        self.running.lock().unwrap().insert(
            id,
            Running {
                child: child.clone(),
                cancelled: cancelled.clone(),
            },
        );
        let running = self.running.clone();
        std::thread::spawn(move || {
            // Readers end when the process closes its output (it ended or was killed).
            let _ = out_reader.join();
            let _ = err_reader.join();
            let status = child.lock().unwrap().wait();
            running.lock().unwrap().remove(&id);
            let event = if cancelled.load(Ordering::SeqCst) {
                JobEvent::Done {
                    ok: false,
                    message: Some("Przerwano".into()),
                }
            } else {
                match status {
                    Ok(s) if s.success() => JobEvent::Done {
                        ok: true,
                        message: None,
                    },
                    Ok(s) => {
                        let tail: Vec<String> = tail.lock().unwrap().iter().cloned().collect();
                        JobEvent::Done {
                            ok: false,
                            message: Some(docker.classify(&tail.join("\n"), s.code()).to_string()),
                        }
                    }
                    Err(e) => JobEvent::Done {
                        ok: false,
                        message: Some(e.to_string()),
                    },
                }
            };
            events.emit(event);
        });
        Ok(id)
    }

    /// Stops a job (its end arrives as `Done` with "Przerwano"). A finished job is ignored.
    pub fn cancel(&self, id: u64) {
        if let Some(job) = self.running.lock().unwrap().get(&id) {
            job.cancelled.store(true, Ordering::SeqCst);
            let _ = job.child.lock().unwrap().kill();
        }
    }

    /// Stops every job (application exit).
    pub fn cancel_all(&self) {
        let ids: Vec<u64> = self.running.lock().unwrap().keys().copied().collect();
        for id in ids {
            self.cancel(id);
        }
    }

    pub fn count(&self) -> usize {
        self.running.lock().unwrap().len()
    }
}

/// `docker pull <image>`.
pub fn pull_args(image: &str) -> Result<Vec<String>, String> {
    let image = image.trim();
    if !valid_reference(image) {
        return Err("Podaj obraz, np. node:22-bookworm-slim".into());
    }
    Ok(vec!["pull".into(), "--".into(), image.into()])
}

/// `docker build` of a folder with a `Dockerfile` (or `dockerfile` inside it), tagged `tag`.
pub fn build_args(dir: &str, tag: &str, dockerfile: Option<&str>) -> Result<Vec<String>, String> {
    let path = std::path::Path::new(dir);
    if !path.is_absolute() || !path.is_dir() {
        return Err(format!("Folder nie istnieje: {dir}"));
    }
    let tag = tag.trim();
    if !valid_reference(tag) {
        return Err("Podaj nazwę obrazu, np. moj-obraz:1.0".into());
    }
    let file = match dockerfile.map(str::trim).filter(|f| !f.is_empty()) {
        Some(f) => path.join(f),
        None => path.join("Dockerfile"),
    };
    if !file.is_file() {
        return Err(format!("Brak pliku {}", file.display()));
    }
    Ok(vec![
        "build".into(),
        "--progress=plain".into(),
        "-t".into(),
        tag.into(),
        "-f".into(),
        file.to_string_lossy().into_owned(),
        "--".into(),
        dir.into(),
    ])
}

/// `docker logs --follow`: the last 1000 lines, then new ones until stopped.
pub fn logs_args(container: &str) -> Result<Vec<String>, String> {
    if !valid_reference(container) {
        return Err(format!("Nieprawidłowa nazwa kontenera: {container}"));
    }
    Ok(["logs", "--follow", "--tail", "1000", "--", container]
        .map(String::from)
        .to_vec())
}
