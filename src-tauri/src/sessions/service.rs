use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::cast::CastWriter;
use super::db::{Facets, NewSession, SessionDb, SessionFilter, SessionRecord};
use super::now_ms;
use super::recorder::Recorder;
use super::transcript::AcpTranscript;
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
    /// ACP conversations being recorded (row ids).
    active_acp: Arc<Mutex<HashSet<i64>>>,
}

/// Who and where an ACP conversation runs (stored with its transcript).
#[derive(Debug, Clone, Default)]
pub struct ConversationInfo {
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub cwd: Option<String>,
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
        let svc = Self {
            dir,
            db: Arc::new(db),
            settings: SettingsStore::new(config_dir),
            active: Arc::new(Mutex::new(HashMap::new())),
            active_acp: Arc::new(Mutex::new(HashSet::new())),
        };
        svc.spawn_text_flusher();
        Ok(svc)
    }

    /// Every couple of seconds, indexes text of running recordings that has been waiting.
    /// The thread ends when the service is dropped.
    fn spawn_text_flusher(&self) {
        let active = Arc::downgrade(&self.active);
        std::thread::Builder::new()
            .name("session-text-flush".into())
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let Some(active) = active.upgrade() else {
                    return;
                };
                let recorders: Vec<Arc<Recorder>> =
                    active.lock().unwrap().values().cloned().collect();
                drop(active);
                for r in recorders {
                    r.flush_pending();
                }
            })
            .ok();
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
            kind: "terminal".into(),
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

    /// Starts recording an ACP conversation (when recording is enabled). The history gets the
    /// conversation once it has content.
    pub fn start_conversation(&self, info: &ConversationInfo) -> Option<Arc<AcpTranscript>> {
        if !self.recording_enabled() {
            return None;
        }
        let file_name = format!(
            "{}-{}-{}.acp.jsonl",
            now_ms(),
            info.agent_id.as_deref().unwrap_or("agent"),
            std::process::id()
        );
        let meta = NewSession {
            kind: "acp".into(),
            agent_id: info.agent_id.clone(),
            agent_name: info.agent_name.clone(),
            profile_id: info.profile_id.clone(),
            profile_name: info.profile_name.clone(),
            cwd: info.cwd.clone(),
            started_at: 0,
            cast_path: String::new(),
        };
        Some(Arc::new(AcpTranscript::new(
            self.db.clone(),
            self.active_acp.clone(),
            self.dir.join(file_name),
            meta,
        )))
    }

    /// Continues recording a conversation from the history (when recording is enabled).
    pub fn resume_conversation(&self, id: i64) -> Result<Option<Arc<AcpTranscript>>, String> {
        if !self.recording_enabled() {
            return Ok(None);
        }
        if self.is_active(id) {
            return Err("Ta rozmowa jest już otwarta".into());
        }
        AcpTranscript::resume(self.db.clone(), self.active_acp.clone(), id)
            .map(|t| Some(Arc::new(t)))
    }

    pub fn get(&self, id: i64) -> Result<Option<SessionRecord>, String> {
        self.db.get(id)
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
        self.active_acp.lock().unwrap().contains(&id)
            || self
                .active
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

    /// Best-effort cleanup. Windows refuses to delete files that are still open (the database,
    /// a recording of a session that is still running), so callers drop those first and a
    /// leftover temp file never fails a test.
    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

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
        drop(svc);
        cleanup(&dir);
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
            drop(svc);
            cleanup(&dir);
        }
    }

    #[test]
    fn running_sessions_become_searchable_without_finishing() {
        let dir = temp("live");
        let svc = SessionService::open(&dir, &dir).unwrap();
        let r = svc.start(&agent_request()).unwrap().unwrap();
        svc.attach(7, r.clone());
        // One burst of output, then silence: the background flush must still index it.
        r.data(b"\x1b[32mlive refactor\x1b[0m\r\n");
        std::thread::sleep(std::time::Duration::from_millis(3000));
        let found = svc
            .list(&SessionFilter {
                query: Some("refactor".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            found.len(),
            1,
            "indexed after the flush interval, while still running"
        );
        svc.finished(&r, Some(0));
        drop(svc);
        cleanup(&dir);
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
        svc.finished(&running, Some(0)); // closes the recording file
        drop(svc);
        cleanup(&dir);
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
        drop(svc);
        cleanup(&dir); // the "crashed" recorder still holds its file open on purpose
    }

    fn conversation_info() -> ConversationInfo {
        ConversationInfo {
            agent_id: Some("claude".into()),
            agent_name: Some("Claude Code".into()),
            profile_id: Some("local:bash".into()),
            profile_name: Some("bash".into()),
            cwd: Some("/src/sklep".into()),
        }
    }

    fn chunk(kind: &str, text: &str) -> serde_json::Value {
        serde_json::json!({ "type": "update", "update": {
            "sessionUpdate": kind, "content": { "type": "text", "text": text } } })
    }

    fn acp_only() -> SessionFilter {
        SessionFilter {
            kind: Some("acp".into()),
            ..Default::default()
        }
    }

    #[test]
    fn conversations_are_kept_only_once_they_have_content() {
        let dir = temp("acp-empty");
        let svc = SessionService::open(&dir, &dir).unwrap();
        let t = svc.start_conversation(&conversation_info()).unwrap();
        t.event(serde_json::json!({ "type": "initialized", "agentInfo": null, "agentCapabilities": {}, "authMethods": [] }));
        t.event(serde_json::json!({ "type": "sessionReady", "sessionId": "s-1", "cwd": "/src/sklep", "modes": null, "configOptions": null }));
        t.finish(Some(0));
        assert!(
            svc.list(&acp_only()).unwrap().is_empty(),
            "opened and closed without a word"
        );
        assert!(std::fs::read_dir(dir.join("recordings"))
            .unwrap()
            .next()
            .is_none());

        // Recording off: nothing at all.
        svc.set_recording_enabled(false).unwrap();
        assert!(svc.start_conversation(&conversation_info()).is_none());
        drop(svc);
        cleanup(&dir);
    }

    #[test]
    fn a_conversation_is_recorded_searched_and_resumed() {
        let dir = temp("acp");
        let svc = SessionService::open(&dir, &dir).unwrap();
        let t = svc.start_conversation(&conversation_info()).unwrap();
        t.event(serde_json::json!({ "type": "initialized", "agentInfo": { "name": "fake" }, "agentCapabilities": { "loadSession": true }, "authMethods": [] }));
        t.event(serde_json::json!({ "type": "sessionReady", "sessionId": "s-1", "cwd": "/src/sklep", "modes": null, "configOptions": null }));
        t.event(serde_json::json!({ "type": "log", "line": "stderr noise" }));
        t.sent("Popraw walidację formularza\nszczegóły niżej");
        t.event(chunk(
            "agent_message_chunk",
            "Poprawiłem kod; teraz pole „Miejscowość” jest wymagane, ",
        ));
        t.event(chunk(
            "agent_message_chunk",
            "a błąd pokazuje się na żółto.",
        ));
        t.event(serde_json::json!({ "type": "fsRequest", "requestId": 1, "op": "write", "path": "/src/sklep/a.ts", "inside": true, "content": "tajna treść pliku" }));
        t.turn_ended("end_turn");

        let rec = svc.get(t.id().unwrap()).unwrap().unwrap();
        assert_eq!(rec.kind, "acp");
        assert_eq!(rec.acp_session_id.as_deref(), Some("s-1"));
        assert_eq!(rec.title.as_deref(), Some("Popraw walidację formularza"));
        assert_eq!(rec.cwd.as_deref(), Some("/src/sklep"));
        assert!(rec.ended_at.is_none(), "running");
        assert!(
            svc.delete(rec.id).is_err(),
            "a running conversation is not deleted"
        );

        // Searchable while running, by a word from the answer, also without Polish letters.
        let find = |q: &str| {
            svc.list(&SessionFilter {
                query: Some(q.into()),
                ..acp_only()
            })
            .unwrap()
        };
        assert_eq!(find("miejscowosc")[0].id, rec.id);
        assert_eq!(find("zolto")[0].id, rec.id);
        assert_eq!(find("walidacje")[0].id, rec.id);
        assert!(find("tajna").is_empty(), "file contents are not kept");
        assert!(svc
            .list(&SessionFilter {
                kind: Some("terminal".into()),
                ..Default::default()
            })
            .unwrap()
            .is_empty());

        t.event(serde_json::json!({ "type": "update", "update": { "sessionUpdate": "session_info_update", "title": "Walidacja formularza" } }));
        t.event(serde_json::json!({ "type": "exited", "code": 0, "message": null }));
        t.finish(Some(0));
        let rec = svc.get(rec.id).unwrap().unwrap();
        assert!(rec.ended_at.is_some());
        assert_eq!(
            rec.title.as_deref(),
            Some("Walidacja formularza"),
            "the agent's title wins"
        );

        let text = svc.read(rec.id).unwrap();
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines[0]["leverframe"], "acp-transcript");
        assert_eq!(
            lines[1]["event"]["type"], "initialized",
            "the handshake is kept"
        );
        assert!(lines
            .iter()
            .any(|l| l["sent"] == "Popraw walidację formularza\nszczegóły niżej"));
        assert!(lines.iter().any(|l| l["turnEnded"] == "end_turn"));
        assert!(!text.contains("stderr noise") && !text.contains("tajna"));

        // Resumed the next day: the same row and file go on.
        let r = svc.resume_conversation(rec.id).unwrap().unwrap();
        assert!(svc.resume_conversation(rec.id).is_err(), "open only once");
        assert!(svc.get(rec.id).unwrap().unwrap().ended_at.is_none());
        r.sent("A teraz dodaj test");
        r.event(chunk("agent_message_chunk", "Dodałem test jednostkowy."));
        r.turn_ended("end_turn");
        r.finish(None);
        assert_eq!(find("jednostkowy")[0].id, rec.id);
        let text = svc.read(rec.id).unwrap();
        assert!(text.contains("\"resumed\":true"));
        assert!(text.contains("A teraz dodaj test"));
        assert_eq!(svc.list(&acp_only()).unwrap().len(), 1);

        svc.delete(rec.id).unwrap();
        assert!(svc.list(&acp_only()).unwrap().is_empty());
        drop(svc);
        cleanup(&dir);
    }
}
