//! SessionService: recordings of agent sessions (asciicast v2) with metadata and a full-text index
//! in SQLite (FTS5). Adapters for the agents' own logs follow in stage 5 (#7).

mod cast;
pub mod commands;
mod db;
mod recorder;
mod service;
mod text;

pub use cast::{decode_utf8, CastWriter};
pub use db::{fold, fts_query, Facet, Facets, NewSession, SessionDb, SessionFilter, SessionRecord};
pub use recorder::Recorder;
pub use service::{RecordingRequest, SessionService, SessionsInfo};
pub use text::TextExtractor;

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
