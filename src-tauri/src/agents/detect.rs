//! Checks which agents are installed in a terminal profile – locally, inside WSL or on an SSH host –
//! by running one small script in that environment and parsing its marked output lines.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::model::AgentDef;
use crate::profiles::{Profile, ProfileKind};

const MARK: &str = "@@LF@@";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub id: String,
    pub installed: bool,
    /// The executable that was found (e.g. `kilo` or `kilocode`).
    pub command: Option<String>,
    /// First line of `<command> --version`.
    pub version: Option<String>,
}

/// Shell family used to run the detection script.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptKind {
    Posix,
    PowerShell,
}

/// POSIX `sh` lines that take `PATH` from the user's login+interactive shell (`$SHELL`):
/// version managers such as nvm usually set it in `.bashrc` / `.zshrc`, which `sh` does not read.
pub const LOGIN_PATH_PRELUDE: &str = r#"lf_out=$("${SHELL:-/bin/sh}" -ilc 'printf "@@PATH@@%s@@END@@" "$PATH"' </dev/null 2>/dev/null)
case "$lf_out" in *@@PATH@@*@@END@@*)
  lf_path=${lf_out#*@@PATH@@}; lf_path=${lf_path%%@@END@@*}
  [ -n "$lf_path" ] && PATH="$lf_path:$PATH"; export PATH ;;
esac
"#;

/// POSIX `sh` script: the login shell's `PATH` first ([`LOGIN_PATH_PRELUDE`]), then every agent.
pub fn posix_script(agents: &[AgentDef]) -> String {
    let mut s = String::from(LOGIN_PATH_PRELUDE);
    s.push_str(
        r#"lf_check() {
  lf_id=$1; lf_va=$2; shift 2
  for lf_c in "$@"; do
    command -v "$lf_c" >/dev/null 2>&1 || continue
    lf_v=$("$lf_c" $lf_va </dev/null 2>/dev/null | head -n 1 | tr '\t\r' '  ')
    printf '@@LF@@\t%s\t1\t%s\t%s\n' "$lf_id" "$lf_c" "$lf_v"
    return
  done
  printf '@@LF@@\t%s\t0\t\t\n' "$lf_id"
}
"#,
    );
    for a in agents {
        s.push_str(&format!(
            "lf_check {} '{}' {}\n",
            a.id,
            a.version_args.join(" "),
            a.commands.join(" ")
        ));
    }
    s
}

/// PowerShell script (Windows PowerShell 5.1 and PowerShell 7). npm installs `.cmd` shims, which
/// `Get-Command` reports as applications, so they are found too.
pub fn powershell_script(agents: &[AgentDef]) -> String {
    let mut s = String::from("$ErrorActionPreference = 'SilentlyContinue'\n");
    for a in agents {
        let names = a
            .commands
            .iter()
            .map(|c| format!("'{c}'"))
            .collect::<Vec<_>>()
            .join(",");
        let args = a
            .version_args
            .iter()
            .map(|c| format!("'{c}'"))
            .collect::<Vec<_>>()
            .join(",");
        s.push_str(&format!(
            "$c = $null; foreach ($n in @({names})) {{ $c = Get-Command -Name $n -CommandType Application,ExternalScript | Select-Object -First 1; if ($c) {{ $cn = $n; break }} }}\n\
             if ($c) {{ $v = (& $c.Source @({args}) 2>$null | Select-Object -First 1) -replace \"`t\", ' '; Write-Output \"{MARK}`t{id}`t1`t$cn`t$v\" }} else {{ Write-Output \"{MARK}`t{id}`t0`t`t\" }}\n",
            id = a.id
        ));
    }
    s
}

/// Parses marked lines; everything else (banners, MOTD, shell noise) is ignored.
/// Agents without a line are reported as not installed.
pub fn parse_output(output: &str, agents: &[AgentDef]) -> Vec<AgentStatus> {
    let found: Vec<AgentStatus> = output
        .lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            let rest = line.split_once(MARK)?.1.strip_prefix('\t')?;
            let mut parts = rest.splitn(4, '\t');
            let id = parts.next()?.to_string();
            let installed = parts.next()? == "1";
            let command = parts.next().filter(|c| !c.is_empty()).map(String::from);
            let version = parts
                .next()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty());
            Some(AgentStatus {
                id,
                installed,
                command,
                version,
            })
        })
        .collect();
    agents
        .iter()
        .map(|a| {
            found
                .iter()
                .find(|s| s.id == a.id)
                .cloned()
                .unwrap_or(AgentStatus {
                    id: a.id.clone(),
                    installed: false,
                    command: None,
                    version: None,
                })
        })
        .collect()
}

/// How the detection script is run for a profile: program, arguments, script kind and
/// whether the script is passed on stdin (POSIX) or as an argument (PowerShell).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub kind: ScriptKind,
}

fn is_windows_shell(cmd: &str) -> bool {
    let lower = cmd.to_ascii_lowercase();
    lower.ends_with("cmd.exe") || lower == "cmd"
}

pub fn detect_command(profile: &Profile) -> DetectCommand {
    let spec = profile.launch_spec();
    match profile.kind {
        ProfileKind::Powershell => DetectCommand {
            program: spec.program,
            args: vec![],
            env: vec![],
            kind: ScriptKind::PowerShell,
        },
        ProfileKind::Wsl => {
            // `wsl.exe -d <distro> -e sh -s` – keep the distribution selection, run sh inside it.
            let mut args: Vec<String> = Vec::new();
            let mut it = spec.args.iter();
            while let Some(a) = it.next() {
                if a == "-d" || a == "--distribution" {
                    args.push(a.clone());
                    if let Some(d) = it.next() {
                        args.push(d.clone());
                    }
                }
            }
            args.extend(["-e", "sh", "-s"].map(String::from));
            DetectCommand {
                program: spec.program,
                args,
                env: vec![],
                kind: ScriptKind::Posix,
            }
        }
        ProfileKind::Ssh => {
            let mut args: Vec<String> = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-T"]
                .map(String::from)
                .to_vec();
            args.extend(spec.args);
            args.push("sh -s".into());
            DetectCommand {
                program: spec.program,
                args,
                env: vec![],
                kind: ScriptKind::Posix,
            }
        }
        ProfileKind::Local if is_windows_shell(&spec.program) => DetectCommand {
            // cmd.exe shares the Windows PATH, so PowerShell can do the lookup.
            program: "powershell.exe".into(),
            args: vec![],
            env: vec![],
            kind: ScriptKind::PowerShell,
        },
        ProfileKind::Local => {
            // Run `sh -s`, but let the script ask *this* shell (via $SHELL) for its PATH.
            let sh = if cfg!(windows) {
                spec.program.clone()
            } else {
                "/bin/sh".to_string()
            };
            DetectCommand {
                program: sh,
                args: vec!["-s".into()],
                env: vec![("SHELL".into(), spec.program)],
                kind: ScriptKind::Posix,
            }
        }
    }
}

/// Runs `cmd` with `script`, killing it after `timeout`. Returns stdout.
pub fn run_script(cmd: &DetectCommand, script: &str, timeout: Duration) -> Result<String, String> {
    let mut command = Command::new(&cmd.program);
    command.args(&cmd.args);
    if cmd.kind == ScriptKind::PowerShell {
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ]);
    }
    for (k, v) in &cmd.env {
        command.env(k, v);
    }
    command
        .stdin(if cmd.kind == ScriptKind::Posix {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Nie można uruchomić {}: {e}", cmd.program))?;
    if cmd.kind == ScriptKind::Posix {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(script.as_bytes());
        }
    }
    let mut stdout = child.stdout.take().expect("piped stdout");
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Sprawdzanie przekroczyło limit czasu ({} s)",
                    timeout.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => return Err(e.to_string()),
        }
    }
    reader
        .join()
        .map_err(|_| "Błąd odczytu wyjścia".to_string())
}

pub fn detect(
    profile: &Profile,
    agents: &[AgentDef],
    timeout: Duration,
) -> Result<Vec<AgentStatus>, String> {
    let cmd = detect_command(profile);
    let script = match cmd.kind {
        ScriptKind::Posix => posix_script(agents),
        ScriptKind::PowerShell => powershell_script(agents),
    };
    let out = run_script(&cmd, &script, timeout)?;
    if !out.contains(MARK) {
        return Err(match profile.kind {
            ProfileKind::Ssh => {
                "Brak odpowiedzi z hosta SSH. Sprawdzanie wymaga logowania kluczem (bez hasła)."
                    .into()
            }
            _ => "Skrypt sprawdzający nie zwrócił wyniku".into(),
        });
    }
    Ok(parse_output(&out, agents))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::model::{load_catalog, BUILTIN_AGENTS_JSON};
    use crate::profiles::{ProfileSource, SshTarget};
    use std::collections::BTreeMap;

    fn agents() -> Vec<AgentDef> {
        load_catalog(BUILTIN_AGENTS_JSON, None).agents
    }

    fn profile(kind: ProfileKind, command: &str, args: &[&str]) -> Profile {
        Profile {
            id: "p".into(),
            name: "p".into(),
            kind,
            command: command.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: BTreeMap::new(),
            cwd: None,
            icon: None,
            description: None,
            ssh: None,
            source: ProfileSource::Detected,
        }
    }

    #[test]
    fn parses_marked_lines_and_ignores_noise() {
        let out = "Welcome to Ubuntu!\n@@LF@@\tclaude\t1\tclaude\t2.1.0 (Claude Code)\r\n\
                   noise @@LF@@ without tab\n@@LF@@\tkilo\t1\tkilocode\t\n@@LF@@\tcodex\t0\t\t\n";
        let s = parse_output(out, &agents());
        assert_eq!(
            s[0],
            AgentStatus {
                id: "claude".into(),
                installed: true,
                command: Some("claude".into()),
                version: Some("2.1.0 (Claude Code)".into())
            }
        );
        assert!(!s[1].installed);
        assert!(!s[2].installed, "missing line = not installed");
        assert_eq!(s[3].command.as_deref(), Some("kilocode"));
        assert_eq!(s[3].version, None);
    }

    #[test]
    fn builds_scripts_for_every_agent() {
        let posix = posix_script(&agents());
        assert!(posix.contains("lf_check kilo '--version' kilo kilocode\n"));
        let ps = powershell_script(&agents());
        assert!(ps.contains("@('kilo','kilocode')"));
        assert!(ps.contains("@@LF@@`tclaude`t1"));
    }

    #[test]
    fn detect_commands_per_profile_kind() {
        let wsl = detect_command(&profile(
            ProfileKind::Wsl,
            "wsl.exe",
            &["-d", "Ubuntu", "--cd", "~"],
        ));
        assert_eq!(wsl.args, ["-d", "Ubuntu", "-e", "sh", "-s"]);

        let mut ssh = profile(ProfileKind::Ssh, "ssh", &[]);
        ssh.ssh = Some(SshTarget {
            host: "srv".into(),
            port: Some(2222),
            user: Some("me".into()),
            identity_file: None,
        });
        let ssh = detect_command(&ssh);
        assert_eq!(ssh.program, "ssh");
        assert_eq!(
            &ssh.args[..5],
            ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-T"]
        );
        assert_eq!(&ssh.args[5..], ["-p", "2222", "me@srv", "sh -s"]);

        let ps = detect_command(&profile(ProfileKind::Powershell, "pwsh.exe", &["-NoLogo"]));
        assert_eq!(
            (ps.program.as_str(), ps.kind),
            ("pwsh.exe", ScriptKind::PowerShell)
        );

        let cmd = detect_command(&profile(
            ProfileKind::Local,
            r"C:\Windows\System32\cmd.exe",
            &[],
        ));
        assert_eq!(cmd.kind, ScriptKind::PowerShell);

        let zsh = detect_command(&profile(ProfileKind::Local, "/usr/bin/zsh", &["-l"]));
        assert_eq!(zsh.kind, ScriptKind::Posix);
        assert_eq!(zsh.env, [("SHELL".to_string(), "/usr/bin/zsh".to_string())]);
    }

    #[cfg(unix)]
    #[test]
    fn detects_fake_agents_in_path_with_versions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("lf-agents-bin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = |name: &str, body: &str| {
            let p = dir.join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        fake("claude", "echo '2.0.1 (Claude Code)'; echo second-line");
        fake("kilocode", "printf 'kilo\\t1.2\\n'");

        // A shell whose login PATH contains the fake binaries: emulates nvm-style PATH setup in .bashrc.
        let shell = dir.join("fake-shell");
        std::fs::write(
            &shell,
            format!(
                "#!/bin/sh\nPATH=\"{}:$PATH\"; export PATH\nshift\nexec /bin/sh -c \"$1\"\n",
                dir.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();

        let p = profile(ProfileKind::Local, shell.to_str().unwrap(), &["-l"]);
        let s = detect(&p, &agents(), Duration::from_secs(10)).unwrap();
        let by = |id: &str| s.iter().find(|x| x.id == id).unwrap().clone();
        assert_eq!(by("claude").version.as_deref(), Some("2.0.1 (Claude Code)"));
        assert!(!by("codex").installed);
        assert_eq!(
            by("kilo").command.as_deref(),
            Some("kilocode"),
            "falls back to the second name"
        );
        assert_eq!(
            by("kilo").version.as_deref(),
            Some("kilo 1.2"),
            "tabs are replaced"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn times_out_on_hanging_environments() {
        let cmd = DetectCommand {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            env: vec![],
            kind: ScriptKind::Posix,
        };
        let start = Instant::now();
        assert!(run_script(&cmd, "", Duration::from_millis(300)).is_err());
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
