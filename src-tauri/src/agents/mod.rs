//! AgentLauncher: AI coding agents (Claude Code, Codex, Agy, Kilo Code, …) defined in
//! `resources/agents.json` + the user's `agents.json`, detected per terminal profile and
//! launched in a new terminal of that profile.

pub mod commands;
mod detect;
mod model;
mod service;

pub use detect::{
    detect, detect_command, parse_output, posix_script, powershell_script, run_script, AgentStatus,
    LOGIN_PATH_PRELUDE,
};
pub use model::{load_catalog, AgentCatalog, AgentDef, InstallHint, BUILTIN_AGENTS_JSON};
pub use service::{AgentService, AgentView, AgentsState};
