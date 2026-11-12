//! Transcript of an ACP conversation: JSON lines in `recordings/` (the events the UI saw, the
//! user's messages and the ends of turns), indexed for full-text search in `sessions.db`.
//!
//! Lines: a header `{"leverframe":"acp-transcript","version":1}`, then `{"t":ms,"event":…}`,
//! `{"t":ms,"sent":"…"}`, `{"t":ms,"turnEnded":"end_turn"}`, `{"t":ms,"reset":true}` (another
//! session of the agent was opened in the panel) and `{"t":ms,"resumed":true}`. The UI replays
//! them through the same reducer as a live conversation.

use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::db::{NewSession, SessionDb};
use super::now_ms;

pub const TRANSCRIPT_VERSION: u64 = 1;
/// Diffs are kept short in the history: each text is cut to this many characters.
pub const MAX_DIFF_TEXT: usize = 4000;
/// Output of one command kept in the history.
pub const MAX_TERMINAL_OUTPUT: usize = 32 * 1024;
/// Text waiting for the index is written once it reaches this size (and at the end of a turn).
const TEXT_FLUSH: usize = 16 * 1024;
const TITLE_CHARS: usize = 80;

struct Inner {
    /// Row in `sessions.db`, once the conversation has content.
    id: Option<i64>,
    file: Option<BufWriter<File>>,
    /// Lines from before the row existed (the handshake), written when it is created.
    pending: Vec<String>,
    acp_session_id: Option<String>,
    text: String,
    terminal_bytes: HashMap<String, usize>,
    finished: bool,
}

/// One conversation being recorded (cheap to share between the event sink and the commands).
pub struct AcpTranscript {
    db: Arc<SessionDb>,
    active: Arc<Mutex<HashSet<i64>>>,
    path: PathBuf,
    meta: NewSession,
    inner: Mutex<Inner>,
}

/// Cuts `text` to `max` characters (at a character boundary), marking the cut.
fn shorten(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => format!("{}\n… (skrócono)", &text[..cut]),
        None => text.to_string(),
    }
}

/// Shortens the texts of diffs anywhere in a value (tool calls, permission requests).
fn shorten_diffs(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("diff") {
                for key in ["oldText", "newText"] {
                    if let Some(Value::String(s)) = map.get_mut(key) {
                        if s.chars().count() > MAX_DIFF_TEXT {
                            *s = shorten(s, MAX_DIFF_TEXT);
                        }
                    }
                }
            }
            map.values_mut().for_each(shorten_diffs);
        }
        Value::Array(items) => items.iter_mut().for_each(shorten_diffs),
        _ => {}
    }
}

fn title_from(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(match line.char_indices().nth(TITLE_CHARS) {
        Some((cut, _)) => format!("{}…", &line[..cut]),
        None => line.to_string(),
    })
}

/// Text of a message chunk or a tool call title in a `session/update`, for the index.
fn update_text(update: &Value) -> Option<String> {
    match update.get("sessionUpdate")?.as_str()? {
        "agent_message_chunk" | "user_message_chunk" | "agent_thought_chunk" => {
            let content = update.get("content")?;
            (content.get("type")?.as_str()? == "text")
                .then(|| content.get("text")?.as_str().map(String::from))
                .flatten()
        }
        "tool_call" | "tool_call_update" => update
            .get("title")
            .and_then(Value::as_str)
            .map(|t| format!("\n{t}\n")),
        _ => None,
    }
}

/// Whether an update is part of the conversation itself (it makes the conversation worth keeping).
fn is_content(update: &Value) -> bool {
    matches!(
        update.get("sessionUpdate").and_then(Value::as_str),
        Some("agent_message_chunk" | "user_message_chunk" | "tool_call")
    )
}

impl AcpTranscript {
    /// A new conversation; nothing is stored until it has content.
    pub(super) fn new(
        db: Arc<SessionDb>,
        active: Arc<Mutex<HashSet<i64>>>,
        path: PathBuf,
        meta: NewSession,
    ) -> Self {
        Self {
            db,
            active,
            path,
            meta,
            inner: Mutex::new(Inner {
                id: None,
                file: None,
                pending: Vec::new(),
                acp_session_id: None,
                text: String::new(),
                terminal_bytes: HashMap::new(),
                finished: false,
            }),
        }
    }

    /// A conversation from the history continued: new lines go to the end of its file.
    pub(super) fn resume(
        db: Arc<SessionDb>,
        active: Arc<Mutex<HashSet<i64>>>,
        id: i64,
    ) -> Result<Self, String> {
        let rec = db.get(id)?.ok_or("Rozmowa nie istnieje w historii")?;
        if rec.kind != "acp" {
            return Err("To nie jest rozmowa z agentem".into());
        }
        let file = OpenOptions::new()
            .append(true)
            .open(&rec.cast_path)
            .map_err(|e| format!("Nie można otworzyć zapisu rozmowy: {e}"))?;
        db.reopen(id)?;
        active.lock().unwrap().insert(id);
        let t = Self::new(
            db,
            active,
            PathBuf::from(&rec.cast_path),
            NewSession::default(),
        );
        {
            let mut inner = t.inner.lock().unwrap();
            inner.id = Some(id);
            inner.file = Some(BufWriter::new(file));
            inner.acp_session_id = rec.acp_session_id;
        }
        t.write(json!({ "t": now_ms(), "resumed": true }));
        Ok(t)
    }

    /// The row in the history, once there is one.
    pub fn id(&self) -> Option<i64> {
        self.inner.lock().unwrap().id
    }

    /// An event of the session (serialized `AcpEvent`). Logs are not kept, file contents and
    /// long diffs are left out, command output is capped.
    pub fn event(&self, mut event: Value) {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match kind.as_str() {
            "log" => return,
            "fsRequest" => {
                if let Some(map) = event.as_object_mut() {
                    map.remove("content");
                }
            }
            "terminalOutput" => {
                let id = event["terminalId"].as_str().unwrap_or_default().to_string();
                let len = event["data"].as_str().map_or(0, str::len);
                let mut inner = self.inner.lock().unwrap();
                let used = inner.terminal_bytes.entry(id).or_insert(0);
                if *used >= MAX_TERMINAL_OUTPUT {
                    return;
                }
                *used += len;
            }
            _ => {}
        }
        shorten_diffs(&mut event);
        let mut create = false;
        match kind.as_str() {
            "sessionReady" => {
                if let Some(sid) = event["sessionId"].as_str() {
                    let mut inner = self.inner.lock().unwrap();
                    inner.acp_session_id = Some(sid.to_string());
                    if let Some(id) = inner.id {
                        let _ = self.db.set_acp_session_id(id, sid);
                    }
                }
            }
            "update" => {
                let update = &event["update"];
                if let Some(text) = update_text(update) {
                    self.inner.lock().unwrap().text.push_str(&text);
                }
                create = is_content(update);
                if update["sessionUpdate"] == "session_info_update" {
                    if let Some(title) = update["title"].as_str().filter(|t| !t.trim().is_empty()) {
                        if let Some(id) = self.id() {
                            let _ = self.db.set_title(id, title, false);
                        }
                    }
                }
            }
            _ => {}
        }
        if create {
            self.ensure_row();
        }
        self.write(json!({ "t": now_ms(), "event": event }));
        self.flush_text_if_large();
    }

    /// The user's message (a new turn).
    pub fn sent(&self, text: &str) {
        self.ensure_row();
        if let (Some(id), Some(title)) = (self.id(), title_from(text)) {
            let _ = self.db.set_title(id, &title, true);
        }
        self.inner
            .lock()
            .unwrap()
            .text
            .push_str(&format!("\n{text}\n"));
        self.write(json!({ "t": now_ms(), "sent": text }));
    }

    pub fn turn_ended(&self, stop_reason: &str) {
        self.write(json!({ "t": now_ms(), "turnEnded": stop_reason }));
        self.flush_text();
    }

    /// Another session of the agent was opened in the same panel: the timeline starts over.
    pub fn reset(&self) {
        self.write(json!({ "t": now_ms(), "reset": true }));
    }

    /// The conversation ended (agent exited, panel closed). Later calls do nothing.
    pub fn finish(&self, exit_code: Option<i64>) {
        self.flush_text();
        let mut inner = self.inner.lock().unwrap();
        if inner.finished {
            return;
        }
        inner.finished = true;
        if let Some(f) = inner.file.as_mut() {
            let _ = f.flush();
        }
        inner.file = None;
        if let Some(id) = inner.id {
            let bytes = std::fs::metadata(&self.path).map_or(0, |m| m.len() as i64);
            let _ = self.db.finish(id, now_ms(), exit_code, bytes);
            self.active.lock().unwrap().remove(&id);
        }
    }

    /// Creates the row and the file (header and the lines waiting for them).
    fn ensure_row(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.id.is_some() || inner.finished {
            return;
        }
        let file = match File::create(&self.path) {
            Ok(f) => f,
            Err(_) => return,
        };
        let mut meta = self.meta.clone();
        meta.kind = "acp".into();
        meta.started_at = now_ms();
        meta.cast_path = self.path.to_string_lossy().into_owned();
        let Ok(id) = self.db.insert(&meta) else {
            return;
        };
        self.active.lock().unwrap().insert(id);
        if let Some(sid) = &inner.acp_session_id {
            let _ = self.db.set_acp_session_id(id, sid);
        }
        let mut file = BufWriter::new(file);
        let header = json!({ "leverframe": "acp-transcript", "version": TRANSCRIPT_VERSION });
        let _ = writeln!(file, "{header}");
        for line in inner.pending.drain(..) {
            let _ = writeln!(file, "{line}");
        }
        inner.id = Some(id);
        inner.file = Some(file);
    }

    fn write(&self, line: Value) {
        let mut inner = self.inner.lock().unwrap();
        if inner.finished {
            return;
        }
        let line = line.to_string();
        match inner.file.as_mut() {
            Some(f) => {
                let _ = writeln!(f, "{line}");
                let _ = f.flush();
            }
            None => inner.pending.push(line),
        }
    }

    fn flush_text_if_large(&self) {
        if self.inner.lock().unwrap().text.len() >= TEXT_FLUSH {
            self.flush_text();
        }
    }

    /// Indexes the text gathered so far (only once the conversation has a row).
    fn flush_text(&self) {
        let mut inner = self.inner.lock().unwrap();
        let Some(id) = inner.id else {
            return;
        };
        let text = std::mem::take(&mut inner.text);
        drop(inner);
        let _ = self.db.append_text(id, &text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diffs_and_titles_are_shortened() {
        let long = "x".repeat(MAX_DIFF_TEXT + 10);
        let mut v = json!({ "toolCall": { "content": [{ "type": "diff", "path": "a", "oldText": long, "newText": "ok" }] } });
        shorten_diffs(&mut v);
        let old = v["toolCall"]["content"][0]["oldText"].as_str().unwrap();
        assert!(old.ends_with("(skrócono)") && old.len() < MAX_DIFF_TEXT + 30);
        assert_eq!(v["toolCall"]["content"][0]["newText"], "ok");
        assert_eq!(
            title_from("\n  Popraw testy  \nszczegóły").as_deref(),
            Some("Popraw testy")
        );
        assert_eq!(
            title_from(&"ż".repeat(100)).unwrap().chars().count(),
            TITLE_CHARS + 1
        );
        assert_eq!(title_from("  \n "), None);
    }
}
