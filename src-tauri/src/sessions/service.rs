use std::collections::HashMap;
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::cast::CastWriter;
use super::db::{Facets, NewSession, SessionDb, SessionFilter, SessionRecord};
use super::now_ms;
use super::recorder::Recorder;
use crate::pty::PtyId;
use crate::settings::SettingsStore;

const RECORD_KEY: &str = "recordSessions";
/// Recordings larger than this are not loaded into the player at once.
pub const MAX_READ_BYTES: u64 = 64 * 1024 * 1024;

/// Information needed to start recording a terminal.
#[derive(Debug, Clone, Default)]
pub struct RecordingRequest {
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsInfo {
    pub recording_enabled: bool,
    pub recordings_dir: String,
}

/// Records agent sessions (asciicast files in `recordings/`) and indexes them in `sessions.db`.
/// Cheap to clone (shared state), so PTY event handlers can keep a handle.
#[derive(Clone)]
pub struct SessionService {
    dir: PathBuf,
    db: Arc<SessionDb>,
    settings: SettingsStore,
    active: Arc<Mutex<HashMap<PtyId, Arc<Recorder>>>>,
}

fn file_mtime_ms(path: &str) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(
        modified
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis() as i64,
    )
}

impl SessionService {
    /// `data_dir` holds `sessions.db` and `recordings/`; settings come from `config_dir`.
    pub fn open(data_dir: &Path, config_dir: &Path) -> Result<Self, String> {
        let dir = data_dir.join("recordings");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Nie można utworzyć {}: {e}", dir.display()))?;
        let db = SessionDb::open(&data_dir.join("sessions.db"))?;
        db.close_interrupted(file_mtime_ms)?;
        Ok(Self {
            dir,
            db: Arc::new(db),
            settings: SettingsStore::new(config_dir),
            active: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn info(&self) -> SessionsInfo {
        SessionsInfo {
            recording_enabled: self.recording_enabled(),
            recordings_dir: self.dir.to_string_lossy().into_owned(),
        }
    }

    pub fn recording_enabled(&self) -> bool {
        self.settings
            .get_value(RECORD_KEY)
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    pub fn set_recording_enabled(&self, enabled: bool) -> Result<(), String> {
        self.settings
            .set(RECORD_KEY, serde_json::Value::Bool(enabled))
    }

    /// Starts a recording for an agent session (only agent sessions are recorded, and only when enabled).
    pub fn start(&self, req: &RecordingRequest) -> Result<Option<Arc<Recorder>>, String> {
        if req.agent_id.is_none() || !self.recording_enabled() {
            return Ok(None);
        }
        let started_at = now_ms();
        let file_name = format!(
            "{}-{}-{}.cast",
            started_at,
            req.agent_id.as_deref().unwrap_or("session"),
            std::process::id()
        );
        let path = self.dir.join(file_name);
        let file = File::create(&path).map_err(|e| format!("Nie można zapisać nagrania: {e}"))?;
        let title = [req.agent_name.as_deref(), req.profile_name.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ");
        let cast = CastWriter::new(
            BufWriter::new(file),
            req.cols,
            req.rows,
            (started_at / 1000) as u64,
            &title,
        )
        .map_err(|e| e.to_string())?;
        let id = self.db.insert(&NewSession {
            agent_id: req.agent_id.clone(),
            agent_name: req.agent_name.clone(),
            profile_id: req.profile_id.clone(),
            profile_name: req.profile_name.clone(),
            cwd: req.cwd.clone(),
            started_at,
            cast_path: path.to_string_lossy().into_owned(),
        })?;
        Ok(Some(Arc::new(Recorder::new(id, cast, self.db.clone()))))
    }

    /// Associates a recorder with the PTY it records (for resize events).
    pub fn attach(&self, pty: PtyId, recorder: Arc<Recorder>) {
        self.active.lock().unwrap().insert(pty, recorder);
    }

    pub fn resize(&self, pty: PtyId, cols: u16, rows: u16) {
        if let Some(r) = self.active.lock().unwrap().get(&pty) {
            r.resize(cols, rows);
        }
    }

    pub fn finished(&self, recorder: &Recorder, exit_code: Option<u32>) {
        recorder.finish(exit_code);
        self.active
            .lock()
            .unwrap()
            .retain(|_, r| r.session_id != recorder.session_id);
    }

    /// Removes a recording that never started (spawn failed).
    pub fn discard(&self, recorder: &Recorder) {
        recorder.finish(None);
        if let Ok(paths) = self.db.delete(&[recorder.session_id]) {
            paths.iter().for_each(|p| {
                let _ = std::fs::remove_file(p);
            });
        }
    }

    pub fn list(&self, filter: &SessionFilter) -> Result<Vec<SessionRecord>, String> {
        self.db.list(filter)
    }

    pub fn facets(&self) -> Result<Facets, String> {
        self.db.facets()
    }

    pub fn read(&self, id: i64) -> Result<String, String> {
        let rec = self.db.get(id)?.ok_or("Nagranie nie istnieje")?;
        let len = std::fs::metadata(&rec.cast_path)
            .map_err(|e| format!("Brak pliku nagrania: {e}"))?
            .len();
        if len > MAX_READ_BYTES {
            return Err(format!(
                "Nagranie jest za duże do odtworzenia ({} MB)",
                len / 1024 / 1024
            ));
        }
        std::fs::read_to_string(&rec.cast_path).map_err(|e| e.to_string())
    }

    fn is_active(&self, id: i64) -> bool {
        self.active
            .lock()
            .unwrap()
            .values()
            .any(|r| r.session_id == id)
    }

    pub fn delete(&self, id: i64) -> Result<(), String> {
        if self.is_active(id) {
            return Err("Nie można usunąć trwającej sesji".into());
        }
        for path in self.db.delete(&[id])? {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }

    /// Deletes all finished sessions and their recordings. Returns how many were removed.
    pub fn clear(&self) -> Result<usize, String> {
        let ids: Vec<i64> = self
            .db
            .finished_ids()?
            .into_iter()
            .filter(|id| !self.is_active(*id))
            .collect();
        for path in self.db.delete(&ids)? {
            let _ = std::fs::remove_file(path);
        }
        Ok(ids.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lf-sess-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn agent_request() -> RecordingRequest {
        RecordingRequest {
            agent_id: Some("claude".into()),
            agent_name: Some("Claude Code".into()),
            profile_id: Some("local:sh".into()),
            profile_name: Some("sh".into()),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn records_only_agent_sessions_and_respects_the_setting() {
        let dir = temp("setting");
        let svc = SessionService::open(&dir, &dir).unwrap();
        assert!(svc
            .start(&RecordingRequest {
                agent_id: None,
                ..agent_request()
            })
            .unwrap()
            .is_none());
        assert!(svc.recording_enabled());
        svc.set_recording_enabled(false).unwrap();
        assert!(svc.start(&agent_request()).unwrap().is_none());
        assert!(!svc.info().recording_enabled);
        svc.set_recording_enabled(true).unwrap();
        assert!(svc.start(&agent_request()).unwrap().is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Spawns a real shell in a PTY, so Unix only (like the PTY tests in `pty::manager`).
    #[cfg(unix)]
    mod pty_recording {
        use super::*;
        use crate::pty::{PtyEvents, PtyManager, SpawnOptions};
        use std::time::{Duration, Instant};

        struct Wrapped {
            recorder: Arc<Recorder>,
            svc: Arc<SessionService>,
            done: Mutex<bool>,
        }
        impl PtyEvents for Wrapped {
            fn data(&self, bytes: Vec<u8>) {
                self.recorder.data(&bytes);
            }
            fn exit(&self, code: Option<u32>) {
                self.svc.finished(&self.recorder, code);
                *self.done.lock().unwrap() = true;
            }
        }

        #[test]
        fn records_a_real_terminal_session_end_to_end() {
            let dir = temp("e2e");
            let svc = Arc::new(SessionService::open(&dir, &dir).unwrap());
            let recorder = svc.start(&agent_request()).unwrap().unwrap();
            let events = Arc::new(Wrapped {
                recorder: recorder.clone(),
                svc: svc.clone(),
                done: Mutex::new(false),
            });
            let mgr = PtyManager::new();
            let pty = mgr
                .spawn(
                    SpawnOptions {
                        program: Some("/bin/sh".into()),
                        args: vec![
                            "-c".into(),
                            "read x; printf '\\033[32mrefactor done: %s\\033[0m\\n' \"$x\"; exit 3"
                                .into(),
                        ],
                        cols: 80,
                        rows: 24,
                        ..Default::default()
                    },
                    events.clone(),
                )
                .unwrap();
            svc.attach(pty.id, recorder.clone());
            svc.resize(pty.id, 100, 30);
            mgr.write(pty.id, b"zazolc\n").unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !*events.done.lock().unwrap() {
                assert!(Instant::now() < deadline, "timeout");
                std::thread::sleep(Duration::from_millis(10));
            }

            let list = svc.list(&SessionFilter::default()).unwrap();
            assert_eq!(list.len(), 1);
            let rec = &list[0];
            assert_eq!(rec.exit_code, Some(3));
            assert!(rec.ended_at.is_some() && rec.bytes > 0);

            let cast = svc.read(rec.id).unwrap();
            let mut lines = cast.lines();
            let header: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
            assert_eq!(header["title"], "Claude Code · sh");
            assert!(cast.contains("\"r\",\"100x30\""));
            assert!(cast.contains("refactor done: zazolc"));

            let found = svc
                .list(&SessionFilter {
                    query: Some("refactor zazolc".into()),
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(found.len(), 1, "output is searchable without escape codes");
            assert!(svc.delete(rec.id).is_ok());
            assert!(
                !Path::new(&rec.cast_path).exists(),
                "file removed with the session"
            );
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn clear_keeps_running_sessions() {
        let dir = temp("clear");
        let svc = SessionService::open(&dir, &dir).unwrap();
        let done = svc.start(&agent_request()).unwrap().unwrap();
        svc.finished(&done, Some(0));
        let running = svc.start(&agent_request()).unwrap().unwrap();
        svc.attach(1, running.clone());
        assert!(svc.delete(running.session_id).is_err());
        assert_eq!(svc.clear().unwrap(), 1);
        let left = svc.list(&SessionFilter::default()).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, running.session_id);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn closes_sessions_left_open_by_a_crash_on_startup() {
        let dir = temp("crash");
        {
            let svc = SessionService::open(&dir, &dir).unwrap();
            let r = svc.start(&agent_request()).unwrap().unwrap();
            r.data(b"partial output");
            std::mem::forget(r); // simulate a crash: never finished
        }
        let svc = SessionService::open(&dir, &dir).unwrap();
        let list = svc.list(&SessionFilter::default()).unwrap();
        assert!(list[0].ended_at.is_some());
        assert_eq!(list[0].exit_code, None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
