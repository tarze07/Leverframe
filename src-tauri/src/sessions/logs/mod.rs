//! Adapters for the agents' own session logs (Claude Code, Codex), normalized to one timeline model,
//! read locally, from WSL distributions or from SSH hosts.
//! Agy and Kilo Code are not covered (no documented log format); their sessions are available
//! as terminal recordings.

mod claude;
mod codex;
pub mod commands;
mod model;
mod service;
mod ssh;
mod watch;

pub use model::{parse_rfc3339, patch_files, AgentKind, LogDetail, LogEntry, LogSummary};
pub use service::{resolve_inside, roots_in_home, wsl_unc_path, AgentLogService, LogRoot};
pub use ssh::{list_script, parse_listing, safe_remote_path, SshLogs};
pub use watch::{watch, LogWatcher};
