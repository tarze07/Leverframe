use std::fs::File;
use std::io::BufWriter;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use super::cast::CastWriter;
use super::db::SessionDb;
use super::now_ms;
use super::text::TextExtractor;

/// Text is indexed in chunks of this size (crash-safe, keeps the transaction small).
const TEXT_CHUNK: usize = 16 * 1024;
/// Limit of indexed text per session; the recording itself is not limited.
const TEXT_LIMIT: usize = 8 * 1024 * 1024;

struct TextState {
    extractor: TextExtractor,
    pending: String,
    indexed: usize,
}

/// Records one terminal session: asciicast file + searchable text in the database.
pub struct Recorder {
    pub session_id: i64,
    cast: Mutex<Option<CastWriter<BufWriter<File>>>>,
    text: Mutex<TextState>,
    db: Arc<SessionDb>,
    bytes: AtomicI64,
}

impl Recorder {
    pub fn new(session_id: i64, cast: CastWriter<BufWriter<File>>, db: Arc<SessionDb>) -> Self {
        Self {
            session_id,
            cast: Mutex::new(Some(cast)),
            text: Mutex::new(TextState {
                extractor: TextExtractor::default(),
                pending: String::new(),
                indexed: 0,
            }),
            db,
            bytes: AtomicI64::new(0),
        }
    }

    pub fn data(&self, bytes: &[u8]) {
        self.bytes.fetch_add(bytes.len() as i64, Ordering::Relaxed);
        if let Some(cast) = self.cast.lock().unwrap().as_mut() {
            let _ = cast.output(bytes);
        }
        let mut t = self.text.lock().unwrap();
        if t.indexed >= TEXT_LIMIT {
            return;
        }
        let text = t.extractor.feed(bytes);
        t.pending.push_str(&text);
        if t.pending.len() >= TEXT_CHUNK {
            self.flush_text(&mut t);
        }
    }

    fn flush_text(&self, t: &mut TextState) {
        let chunk = std::mem::take(&mut t.pending);
        t.indexed += chunk.len();
        let _ = self.db.append_text(self.session_id, &chunk);
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        if let Some(cast) = self.cast.lock().unwrap().as_mut() {
            let _ = cast.resize(cols, rows);
        }
    }

    /// Closes the file and stores end time and exit code. Idempotent.
    pub fn finish(&self, exit_code: Option<u32>) {
        let Some(cast) = self.cast.lock().unwrap().take() else {
            return;
        };
        let _ = cast.finish();
        {
            let mut t = self.text.lock().unwrap();
            if t.indexed < TEXT_LIMIT {
                self.flush_text(&mut t);
            }
        }
        let _ = self.db.finish(
            self.session_id,
            now_ms(),
            exit_code.map(i64::from),
            self.bytes.load(Ordering::Relaxed),
        );
    }
}
