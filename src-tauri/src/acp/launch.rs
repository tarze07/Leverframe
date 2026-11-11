//! How an ACP agent process is started for a terminal profile. No PTY: the agent talks
//! JSON-RPC on plain stdin/stdout pipes.
//!
//! POSIX environments (local Linux/macOS, WSL, SSH hosts) run a small `sh` script: the login
//! shell's `PATH` (agents installed with npm / nvm live there), `cd` for SSH, then a line with the
//! absolute working directory on **stderr** (the agent needs an absolute `cwd` in its own file
//! system, which we cannot compute for WSL or a remote host) and finally `exec` of the agent.

use std::path::{Path, PathBuf};

use crate::agents::LOGIN_PATH_PRELUDE;
use crate::profiles::{Profile, ProfileKind};
use crate::pty::commands::wsl_unc_to_linux;

/// Marker of the stderr line with the agent's working directory.
pub const CWD_MARKER: &str = "@@LF-CWD@@";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpLaunch {
    pub program: String,
    pub args: Vec<String>,
    /// Windows: the command line after the program, passed verbatim (`cmd.exe` does not
    /// understand the quoting Rust applies to `args`).
    pub raw_args: Option<String>,
    pub env: Vec<(String, String)>,
    /// Working directory of the local process.
    pub cwd: Option<PathBuf>,
    /// `Some(dir)` when the session's working directory is known in advance (local Windows);
    /// `None` when the launch script reports it on stderr.
    pub session_cwd: Option<String>,
}

/// POSIX single-quoted word.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `~` and `~/…` keep meaning the home directory.
fn sh_dir(dir: &str) -> String {
    if dir == "~" {
        "~".into()
    } else if let Some(rest) = dir.strip_prefix("~/") {
        format!("~/{}", sh_quote(rest))
    } else {
        sh_quote(dir)
    }
}

/// The `sh` script that starts `command` (program + arguments).
pub fn posix_script(command: &[String], cd: Option<&str>) -> String {
    let mut s = String::from(LOGIN_PATH_PRELUDE);
    if let Some(dir) = cd {
        s.push_str(&format!(
            "cd -- {} || {{ echo \"Leverframe: nie ma katalogu {}\" >&2; exit 1; }}\n",
            sh_dir(dir),
            dir.replace(['"', '\\', '$', '`'], "")
        ));
    }
    s.push_str(&format!("printf '{CWD_MARKER}%s\\n' \"$PWD\" >&2\n"));
    let words: Vec<String> = command.iter().map(|w| sh_quote(w)).collect();
    s.push_str(&format!("exec {}\n", words.join(" ")));
    s
}

/// `cmd.exe` command line: words with spaces or special characters in double quotes.
fn cmd_line(command: &[String]) -> String {
    command
        .iter()
        .map(|w| {
            if w.is_empty() || w.contains(|c: char| c.is_whitespace() || "&|<>^()".contains(c)) {
                format!("\"{w}\"")
            } else {
                w.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_windows_shell(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    lower.ends_with("cmd.exe") || lower == "cmd"
}

/// Launch for `command` in `profile` (`None` = the user's default shell, locally).
/// `local_cwd` is the project folder on this machine; `remote_dir` the directory on an SSH host.
pub fn launch_for(
    profile: Option<&Profile>,
    command: &[String],
    local_cwd: Option<&Path>,
    remote_dir: Option<&str>,
    windows: bool,
) -> AcpLaunch {
    let spec = profile.map(|p| p.launch_spec());
    let kind = profile.map(|p| p.kind).unwrap_or(ProfileKind::Local);
    let profile_env: Vec<(String, String)> =
        spec.as_ref().map(|s| s.env.clone()).unwrap_or_default();
    let local_cwd = local_cwd.map(Path::to_path_buf);
    match kind {
        ProfileKind::Wsl => {
            let spec = spec.expect("a WSL launch has a profile");
            // Keep the distribution selection of the profile, replace the rest.
            let mut args = Vec::new();
            let mut it = spec.args.iter();
            while let Some(a) = it.next() {
                if a == "-d" || a == "--distribution" {
                    args.push(a.clone());
                    if let Some(d) = it.next() {
                        args.push(d.clone());
                    }
                }
            }
            if let Some(dir) = &local_cwd {
                let dir = dir.to_string_lossy();
                args.extend([
                    "--cd".to_string(),
                    wsl_unc_to_linux(&dir).unwrap_or_else(|| dir.into_owned()),
                ]);
            }
            args.extend(["-e", "sh", "-c"].map(String::from));
            args.push(posix_script(command, None));
            AcpLaunch {
                program: spec.program,
                args,
                raw_args: None,
                env: vec![],
                cwd: None,
                session_cwd: None,
            }
        }
        ProfileKind::Ssh => {
            let spec = spec.expect("an SSH launch has a profile");
            // BatchMode: stdin carries the protocol, so ssh must never stop to ask for a password.
            let mut args: Vec<String> = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-T"]
                .map(String::from)
                .to_vec();
            args.extend(spec.args);
            // The remote login shell may not be POSIX (fish): run the script with sh explicitly.
            args.push(format!(
                "sh -c {}",
                sh_quote(&posix_script(command, Some(remote_dir.unwrap_or("~"))))
            ));
            AcpLaunch {
                program: spec.program,
                args,
                raw_args: None,
                env: vec![],
                cwd: None,
                session_cwd: None,
            }
        }
        // On Windows, local agents (npm `.cmd` shims included) are started through cmd.exe,
        // which passes the pipes straight to the agent; PowerShell would re-encode them.
        _ if windows => AcpLaunch {
            program: "cmd.exe".into(),
            args: vec![],
            raw_args: Some(format!("/d /s /c \"{}\"", cmd_line(command))),
            env: profile_env,
            session_cwd: local_cwd.as_ref().map(|d| d.to_string_lossy().into_owned()),
            cwd: local_cwd,
        },
        _ => {
            // The login shell of a POSIX profile provides PATH; for other shells (pwsh) $SHELL stays.
            let mut env = profile_env;
            if let Some(spec) = &spec {
                if kind == ProfileKind::Local && !is_windows_shell(&spec.program) {
                    env.push(("SHELL".into(), spec.program.clone()));
                }
            }
            AcpLaunch {
                program: "/bin/sh".into(),
                args: vec!["-c".into(), posix_script(command, None)],
                raw_args: None,
                env,
                cwd: local_cwd,
                session_cwd: None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{ProfileSource, SshTarget};
    use std::collections::BTreeMap;

    fn profile(kind: ProfileKind, command: &str, args: &[&str]) -> Profile {
        Profile {
            id: "p".into(),
            name: "p".into(),
            kind,
            command: command.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: BTreeMap::from([("LANG".into(), "pl_PL.UTF-8".into())]),
            cwd: None,
            icon: None,
            description: None,
            ssh: None,
            source: ProfileSource::Detected,
        }
    }

    fn cmd(words: &[&str]) -> Vec<String> {
        words.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn scripts_quote_every_word_and_report_the_directory() {
        let s = posix_script(&cmd(&["gemini", "--acp", "it's"]), Some("~/my app"));
        assert!(
            s.starts_with(LOGIN_PATH_PRELUDE),
            "PATH of the login shell first"
        );
        assert!(s.contains("cd -- ~/'my app' ||"));
        assert!(s.contains("printf '@@LF-CWD@@%s\\n' \"$PWD\" >&2"));
        assert!(s.ends_with("exec 'gemini' '--acp' 'it'\\''s'\n"));
        assert_eq!(sh_quote("a'b"), r"'a'\''b'");
    }

    #[test]
    fn local_posix_profiles_run_sh_with_the_profile_shell() {
        let p = profile(ProfileKind::Local, "/bin/zsh", &["-l"]);
        let l = launch_for(
            Some(&p),
            &cmd(&["claude-agent-acp"]),
            Some(Path::new("/work/app")),
            None,
            false,
        );
        assert_eq!(l.program, "/bin/sh");
        assert_eq!(l.args[0], "-c");
        assert!(l.args[1].ends_with("exec 'claude-agent-acp'\n"));
        assert!(l.env.contains(&("SHELL".into(), "/bin/zsh".into())));
        assert!(
            l.env.contains(&("LANG".into(), "pl_PL.UTF-8".into())),
            "profile env kept"
        );
        assert_eq!(l.cwd, Some(PathBuf::from("/work/app")));
        assert_eq!(l.session_cwd, None, "reported by the script");
        // No profile: the user's own $SHELL.
        let l = launch_for(None, &cmd(&["x"]), None, None, false);
        assert!(l.env.iter().all(|(k, _)| k != "SHELL"));
    }

    #[test]
    fn windows_uses_cmd_with_a_verbatim_command_line() {
        let p = profile(ProfileKind::Powershell, "pwsh.exe", &["-NoLogo"]);
        let l = launch_for(
            Some(&p),
            &cmd(&["codex-acp", "--model", "a b"]),
            Some(Path::new(r"C:\src\app")),
            None,
            true,
        );
        assert_eq!(l.program, "cmd.exe");
        assert_eq!(
            l.raw_args.as_deref(),
            Some(r#"/d /s /c "codex-acp --model "a b"""#)
        );
        assert_eq!(l.session_cwd.as_deref(), Some(r"C:\src\app"));
        assert_eq!(l.cwd, Some(PathBuf::from(r"C:\src\app")));
    }

    #[test]
    fn wsl_keeps_the_distribution_and_translates_the_folder() {
        let p = profile(ProfileKind::Wsl, "wsl.exe", &["-d", "Ubuntu", "--cd", "~"]);
        let l = launch_for(
            Some(&p),
            &cmd(&["gemini", "--acp"]),
            Some(Path::new(r"\\wsl.localhost\Ubuntu\home\me\app")),
            None,
            true,
        );
        assert_eq!(l.program, "wsl.exe");
        assert_eq!(
            &l.args[..6],
            &cmd(&["-d", "Ubuntu", "--cd", "/home/me/app", "-e", "sh"])
        );
        assert_eq!(l.args[6], "-c");
        assert!(l.args[7].ends_with("exec 'gemini' '--acp'\n"));
        assert_eq!(l.cwd, None);
        // A Windows folder is translated by WSL itself.
        let l = launch_for(
            Some(&p),
            &cmd(&["x"]),
            Some(Path::new(r"C:\src")),
            None,
            true,
        );
        assert_eq!(&l.args[2..4], &cmd(&["--cd", r"C:\src"]));
    }

    #[test]
    fn ssh_never_prompts_and_changes_to_the_remote_directory() {
        let mut p = profile(ProfileKind::Ssh, "", &[]);
        p.ssh = Some(SshTarget {
            host: "srv".into(),
            user: Some("me".into()),
            port: Some(2222),
            identity_file: None,
        });
        let l = launch_for(
            Some(&p),
            &cmd(&["claude-agent-acp"]),
            Some(Path::new("/local/app")),
            Some("~/projekty/sklep"),
            false,
        );
        assert_eq!(l.program, "ssh");
        assert_eq!(
            &l.args[..5],
            &cmd(&["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-T"])
        );
        let remote = l.args.last().unwrap();
        assert!(remote.starts_with("sh -c '"), "{remote}");
        assert!(
            remote.contains("cd -- ~/'\\''projekty/sklep'\\''"),
            "{remote}"
        );
        assert_eq!(l.cwd, None, "the local folder means nothing on the host");
        // Without a configured directory: the home directory.
        let l = launch_for(Some(&p), &cmd(&["x"]), None, None, false);
        assert!(l.args.last().unwrap().contains("cd -- ~ ||"));
    }
}
