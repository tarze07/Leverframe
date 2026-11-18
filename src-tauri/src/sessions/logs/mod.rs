//! Adapters for the agents' own session logs (Claude Code, Codex, OpenCode, Agy), normalized to
//! one timeline model, read locally, from WSL distributions, from SSH hosts or containers.
//! Gemini CLI is not covered; its sessions are available as terminal recordings.

mod agy;
mod claude;
mod codex;
pub mod commands;
mod model;
mod opencode;
mod service;
mod ssh;
mod watch;

pub use model::{parse_rfc3339, patch_files, AgentKind, LogDetail, LogEntry, LogSummary};
pub use service::{resolve_inside, roots_in_home, wsl_unc_path, AgentLogService, LogRoot};
pub use ssh::{list_script, parse_listing, safe_remote_path, SshLogs};
pub use watch::{watch, LogWatcher};
