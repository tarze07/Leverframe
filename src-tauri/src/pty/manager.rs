use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use super::batcher::spawn_batcher;
use super::shell::{default_shell, home_dir};

pub type PtyId = u32;

/// Receiver of a terminal's output and exit. Implemented over Tauri channels in `commands.rs`
/// and by plain collectors in tests.
pub trait PtyEvents: Send + Sync + 'static {
    fn data(&self, bytes: Vec<u8>);
    fn exit(&self, code: Option<u32>);
}

#[derive(Debug, Clone, Default)]
pub struct SpawnOptions {
    /// Program to run; `None` = default shell.
    pub program: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
    /// Information about what runs in the terminal (kept for the sessions view, stage 4).
    pub meta: SessionMeta,
}

/// What a terminal was started for. `agent_id` marks agent sessions (recorded in stage 4, #6).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub profile_id: Option<String>,
    pub agent_id: Option<String>,
    pub cwd: Option<String>,
    /// Unix time in milliseconds; filled in by `spawn`.
    pub started_at: u64,
}

/// A running terminal, as listed by `pty_list`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub id: PtyId,
    pub program: String,
    pub pid: Option<u32>,
    #[serde(flatten)]
    pub meta: SessionMeta,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpawnedPty {
    pub id: PtyId,
    /// Program that was started (shown as the tab title).
    pub program: String,
    pub pid: Option<u32>,
}

struct Session {
    info: PtyInfo,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// Owns all running terminals. Cheap to clone (shared state).
#[derive(Clone, Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<PtyId, Session>>>,
    next_id: Arc<AtomicU32>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts a process in a new PTY. Output goes to `events.data` in batches;
    /// `events.exit` is called once, after all output has been delivered.
    pub fn spawn(
        &self,
        opts: SpawnOptions,
        events: Arc<dyn PtyEvents>,
    ) -> Result<SpawnedPty, String> {
        let pair = native_pty_system()
            .openpty(size(opts.cols, opts.rows))
            .map_err(err)?;

        let (program, args) = match opts.program {
            Some(p) => (p, opts.args),
            None => {
                let shell = default_shell();
                (shell.program, shell.args)
            }
        };
        let mut cmd = CommandBuilder::new(&program);
        cmd.args(&args);
        if let Some(cwd) = opts.cwd.filter(|p| p.is_dir()).or_else(home_dir) {
            cmd.cwd(cwd);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Leverframe");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        for (k, v) in opts.env {
            cmd.env(k, v);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Nie można uruchomić „{program}”: {e}"))?;
        // Close our copy of the slave so the reader sees EOF when the child exits (Unix).
        drop(pair.slave);

        let pid = child.process_id();
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(err)?;
        let writer = pair.master.take_writer().map_err(err)?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions.lock().unwrap().insert(
            id,
            Session {
                info: PtyInfo {
                    id,
                    program: program.clone(),
                    pid,
                    meta: SessionMeta {
                        started_at: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0),
                        ..opts.meta
                    },
                },
                master: pair.master,
                writer,
                killer,
            },
        );

        // reader thread -> batcher thread -> events.data
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let data_events = events.clone();
        let batcher = spawn_batcher(rx, move |bytes| data_events.data(bytes));
        let reader_thread = std::thread::Builder::new()
            .name(format!("pty-{id}-reader"))
            .spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(err)?;

        // waiter thread: child exit -> drop PTY (unblocks the reader on Windows) -> drain -> exit event
        let sessions = self.sessions.clone();
        std::thread::Builder::new()
            .name(format!("pty-{id}-waiter"))
            .spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code());
                sessions.lock().unwrap().remove(&id);
                let _ = reader_thread.join();
                let _ = batcher.join();
                events.exit(code);
            })
            .map_err(err)?;

        Ok(SpawnedPty { id, program, pid })
    }

    pub fn write(&self, id: PtyId, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(&id).ok_or_else(|| not_found(id))?;
        session.writer.write_all(data).map_err(err)?;
        session.writer.flush().map_err(err)
    }

    pub fn resize(&self, id: PtyId, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(&id).ok_or_else(|| not_found(id))?;
        session.master.resize(size(cols, rows)).map_err(err)
    }

    /// Terminates the process. The exit event follows asynchronously.
    /// Killing an already finished terminal is not an error.
    pub fn kill(&self, id: PtyId) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&id) {
            session.killer.kill().map_err(err)?;
        }
        Ok(())
    }

    /// Terminates every terminal (called when the application exits).
    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for session in sessions.values_mut() {
            let _ = session.killer.kill();
        }
    }

    /// Running terminals, oldest first.
    pub fn list(&self) -> Vec<PtyInfo> {
        let mut list: Vec<PtyInfo> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| s.info.clone())
            .collect();
        list.sort_by_key(|i| i.id);
        list
    }

    pub fn count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }
}

fn not_found(id: PtyId) -> String {
    format!("Terminal {id} nie istnieje lub już się zakończył")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct Collector {
        output: Mutex<Vec<u8>>,
        exit: Mutex<Option<Option<u32>>>,
    }

    impl PtyEvents for Collector {
        fn data(&self, bytes: Vec<u8>) {
            self.output.lock().unwrap().extend(bytes);
        }
        fn exit(&self, code: Option<u32>) {
            *self.exit.lock().unwrap() = Some(code);
        }
    }

    impl Collector {
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.output.lock().unwrap()).into_owned()
        }
        fn exited(&self) -> Option<Option<u32>> {
            *self.exit.lock().unwrap()
        }
    }

    fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !cond() {
            assert!(Instant::now() < deadline, "timeout waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn sh(script: &str) -> SpawnOptions {
        SpawnOptions {
            program: Some("/bin/sh".into()),
            args: vec!["-c".into(), script.into()],
            cols: 80,
            rows: 24,
            ..Default::default()
        }
    }

    #[test]
    fn streams_output_and_reports_exit_code() {
        let mgr = PtyManager::new();
        let events = Arc::new(Collector::default());
        let spawned = mgr
            .spawn(sh("printf 'hello pty'; exit 3"), events.clone())
            .unwrap();
        assert_eq!(spawned.program, "/bin/sh");
        wait_until("exit", || events.exited().is_some());
        assert!(events.text().contains("hello pty"));
        assert_eq!(events.exited(), Some(Some(3)));
        assert_eq!(mgr.count(), 0, "finished session is removed");
    }

    #[test]
    fn writes_input_to_the_process() {
        let mgr = PtyManager::new();
        let events = Arc::new(Collector::default());
        let pty = mgr
            .spawn(sh("read line; echo \"got:$line\""), events.clone())
            .unwrap();
        mgr.write(pty.id, b"abc\n").unwrap();
        wait_until("exit", || events.exited().is_some());
        assert!(
            events.text().contains("got:abc"),
            "output: {}",
            events.text()
        );
    }

    #[test]
    fn resize_is_visible_to_the_process() {
        let mgr = PtyManager::new();
        let events = Arc::new(Collector::default());
        let pty = mgr.spawn(sh("read _; stty size"), events.clone()).unwrap();
        mgr.resize(pty.id, 120, 40).unwrap();
        mgr.write(pty.id, b"\n").unwrap();
        wait_until("exit", || events.exited().is_some());
        assert!(
            events.text().contains("40 120"),
            "output: {}",
            events.text()
        );
    }

    #[test]
    fn sets_terminal_environment() {
        let mgr = PtyManager::new();
        let events = Arc::new(Collector::default());
        mgr.spawn(sh("echo \"$TERM|$TERM_PROGRAM\""), events.clone())
            .unwrap();
        wait_until("exit", || events.exited().is_some());
        assert!(events.text().contains("xterm-256color|Leverframe"));
    }

    #[test]
    fn kill_terminates_the_process() {
        let mgr = PtyManager::new();
        let events = Arc::new(Collector::default());
        let pty = mgr.spawn(sh("sleep 60"), events.clone()).unwrap();
        assert_eq!(mgr.count(), 1);
        mgr.kill(pty.id).unwrap();
        wait_until("exit", || events.exited().is_some());
        assert_eq!(mgr.count(), 0);
        // Killing again / writing to a finished terminal.
        assert!(mgr.kill(pty.id).is_ok());
        assert!(mgr.write(pty.id, b"x").is_err());
    }

    #[test]
    fn lists_running_terminals_with_metadata() {
        let mgr = PtyManager::new();
        let events = Arc::new(Collector::default());
        let mut opts = sh("sleep 60");
        opts.meta = SessionMeta {
            profile_id: Some("local:sh".into()),
            agent_id: Some("claude".into()),
            cwd: Some("/tmp".into()),
            started_at: 0,
        };
        let pty = mgr.spawn(opts, events.clone()).unwrap();
        let list = mgr.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, pty.id);
        assert_eq!(list[0].meta.agent_id.as_deref(), Some("claude"));
        assert!(list[0].meta.started_at > 0, "start time is filled in");
        mgr.kill(pty.id).unwrap();
        wait_until("exit", || events.exited().is_some());
        assert!(mgr.list().is_empty());
    }

    #[test]
    fn kill_all_terminates_every_process() {
        let mgr = PtyManager::new();
        let a = Arc::new(Collector::default());
        let b = Arc::new(Collector::default());
        mgr.spawn(sh("sleep 60"), a.clone()).unwrap();
        mgr.spawn(sh("sleep 60"), b.clone()).unwrap();
        mgr.kill_all();
        wait_until("both exits", || {
            a.exited().is_some() && b.exited().is_some()
        });
        assert_eq!(mgr.count(), 0);
    }

    #[test]
    fn reports_missing_program() {
        let mgr = PtyManager::new();
        let events = Arc::new(Collector::default());
        let opts = SpawnOptions {
            program: Some("/nonexistent/program".into()),
            cols: 80,
            rows: 24,
            ..Default::default()
        };
        assert!(mgr.spawn(opts, events).is_err());
    }
}
