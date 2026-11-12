//! Agents over the Agent Client Protocol (ACP, stable v1): the agent runs as a subprocess and
//! talks JSON-RPC on stdin/stdout; Leverframe is the client. See docs/ACP.md.

pub mod commands;
pub mod fs;
pub mod launch;
pub mod rpc;
pub mod session;
pub mod terminal;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub use launch::{launch_for, AcpLaunch};
pub use session::{AcpEvent, AcpEvents, AcpSession};

/// Running ACP sessions by id (one agent process each).
#[derive(Default)]
pub struct AcpService {
    sessions: Mutex<HashMap<u64, Arc<AcpSession>>>,
    next_id: AtomicU64,
    /// PTYs of agents' commands (`terminal/*`), apart from the user's terminals.
    ptys: Arc<crate::pty::PtyManager>,
    /// Recordings of the conversations (when recording is enabled).
    transcripts: Mutex<HashMap<u64, Arc<crate::sessions::AcpTranscript>>>,
}

impl AcpService {
    pub fn start(
        &self,
        launch: &AcpLaunch,
        events: Arc<dyn AcpEvents>,
        fs: Option<fs::FsKind>,
        resume: Option<String>,
    ) -> Result<u64, String> {
        let session = AcpSession::start(launch, events, fs, self.ptys.clone(), resume)?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        self.sessions.lock().unwrap().insert(id, session);
        Ok(id)
    }

    pub fn set_transcript(&self, id: u64, transcript: Arc<crate::sessions::AcpTranscript>) {
        self.transcripts.lock().unwrap().insert(id, transcript);
    }

    pub fn transcript(&self, id: u64) -> Option<Arc<crate::sessions::AcpTranscript>> {
        self.transcripts.lock().unwrap().get(&id).cloned()
    }

    pub fn get(&self, id: u64) -> Result<Arc<AcpSession>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("Sesja agenta {id} nie istnieje"))
    }

    /// Ends the agent process and forgets the session.
    pub fn stop(&self, id: u64) {
        let session = self.sessions.lock().unwrap().remove(&id);
        if let Some(s) = session {
            s.stop();
        }
        if let Some(t) = self.transcripts.lock().unwrap().remove(&id) {
            t.finish(None);
        }
    }

    /// Ends every agent (application exit).
    pub fn stop_all(&self) {
        let all: Vec<_> = self
            .sessions
            .lock()
            .unwrap()
            .drain()
            .map(|(_, s)| s)
            .collect();
        for s in all {
            s.stop();
        }
        for (_, t) in self.transcripts.lock().unwrap().drain() {
            t.finish(None);
        }
    }
}

#[cfg(test)]
mod tests;
