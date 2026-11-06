use std::path::{Path, PathBuf};

/// Program + arguments used to start a terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// The user's home directory (`HOME`, or `USERPROFILE` on Windows).
pub fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Default local shell: PowerShell 7 → Windows PowerShell on Windows; `$SHELL` (login) → bash → sh elsewhere.
/// Profiles (WSL, SSH, …) replace this in stage 2 (#4).
pub fn default_shell() -> ShellCommand {
    if cfg!(windows) {
        let program = if find_in_path("pwsh.exe").is_some() {
            "pwsh.exe"
        } else {
            "powershell.exe"
        };
        return ShellCommand {
            program: program.into(),
            args: vec!["-NoLogo".into()],
        };
    }
    let program = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty() && Path::new(s).exists())
        .or_else(|| find_in_path("bash").map(|p| p.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "/bin/sh".into());
    ShellCommand {
        program,
        // Login shell, so the user's profile (PATH, nvm, ssh-agent, …) is loaded – like VS Code/Zed.
        args: vec!["-l".into()],
    }
}

/// Searches `PATH` for an executable file name.
pub fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shell_is_not_empty() {
        let shell = default_shell();
        assert!(!shell.program.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn finds_sh_in_path() {
        assert!(find_in_path("sh").is_some());
        assert!(find_in_path("definitely-not-a-real-binary-xyz").is_none());
    }
}
