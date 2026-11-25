//! AgentLauncher: AI coding agents (Claude Code, Codex, Gemini CLI, OpenCode, …) defined in
//! `resources/agents.json` + the user's `agents.json`, detected per terminal profile and
//! launched in a new terminal of that profile. Their settings (arguments, environment, the
//! conversation-mode command, hiding) are overrides in the user's `agents.json`.

mod command;
pub mod commands;
mod detect;
mod model;
mod service;
mod settings;

pub use command::{args_with_prompt, prompt_word, shell_of, typed_command, Shell};
pub use detect::{
    detect, detect_command, parse_output, posix_script, powershell_script, run_script, AgentStatus,
    LOGIN_PATH_PRELUDE,
};
pub use model::{load_catalog, AcpDef, AgentCatalog, AgentDef, InstallHint, BUILTIN_AGENTS_JSON};
pub use service::{AcpView, AgentService, AgentView, AgentsState};
pub use settings::AgentSettings;
