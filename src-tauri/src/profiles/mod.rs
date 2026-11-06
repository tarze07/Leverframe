//! ProfileService: terminal profiles – detected (local shells, WSL, PowerShell, `~/.ssh/config`)
//! and user-defined (`profiles.json`, e.g. SSH hosts added in the UI).

pub mod commands;
mod detect;
mod model;
mod service;

pub use detect::{
    detect_all, parse_etc_shells, parse_ssh_config, parse_wsl_list, wsl_profiles, SshConfigHost,
};
pub use model::{LaunchSpec, Profile, ProfileKind, ProfileSource, SshTarget};
pub use service::{default_profile_id, ProfileService, ProfilesState};
