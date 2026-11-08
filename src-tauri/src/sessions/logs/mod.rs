//! Adapters for the agents' own session logs (Claude Code, Codex), normalized to one timeline model.
//! Agy and Kilo Code are not covered (no documented log format); their sessions are available
//! as terminal recordings.

mod claude;
mod codex;
pub mod commands;
mod model;
mod service;
mod watch;

pub use model::{parse_rfc3339, patch_files, AgentKind, LogDetail, LogEntry, LogSummary};
pub use service::{resolve_inside, roots_in_home, wsl_unc_path, AgentLogService, LogRoot};
pub use watch::{watch, LogWatcher};
