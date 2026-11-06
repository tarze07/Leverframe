//! Detection of terminal profiles available on this machine. Parsers are pure functions
//! (tested below); the `detect_*` functions add the I/O.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use super::model::{Profile, ProfileKind, ProfileSource};
use crate::pty::{find_in_path, home_dir};

fn detected(
    id: String,
    name: String,
    kind: ProfileKind,
    command: String,
    args: Vec<String>,
) -> Profile {
    Profile {
        id,
        name,
        kind,
        command,
        args,
        env: BTreeMap::new(),
        cwd: None,
        icon: None,
        description: None,
        ssh: None,
        source: ProfileSource::Detected,
    }
}

// ---------------------------------------------------------------- local shells

/// Shell paths from `/etc/shells`, without comments, restricted shells and non-shells.
pub fn parse_etc_shells(content: &str) -> Vec<String> {
    const SKIP: &[&str] = &[
        "nologin",
        "false",
        "true",
        "rbash",
        "tmux",
        "screen",
        "git-shell",
    ];
    content
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('/'))
        .filter(|l| {
            let name = Path::new(l)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            !SKIP.contains(&name)
        })
        .map(String::from)
        .collect()
}

fn shell_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .trim_end_matches(".exe")
        .to_string()
}

/// One profile per distinct shell; the user's `$SHELL` first. Paths that resolve to the same
/// binary (`/bin/bash` vs `/usr/bin/bash` on merged-/usr systems) are listed once.
pub fn local_unix_profiles(
    shells: &[String],
    login_shell: Option<&str>,
    exists: impl Fn(&str) -> bool,
) -> Vec<Profile> {
    let canonical = |p: &str| std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
    let mut ordered: Vec<String> = Vec::new();
    if let Some(s) = login_shell.filter(|s| exists(s)) {
        ordered.push(s.to_string());
    }
    ordered.extend(shells.iter().filter(|s| exists(s)).cloned());

    let mut seen_bins = HashSet::new();
    let mut seen_names = HashSet::new();
    let mut out = Vec::new();
    for path in ordered {
        if !seen_bins.insert(canonical(&path)) {
            continue;
        }
        let name = shell_name(&path);
        // Same name from two different binaries (rare): keep the first, it is the preferred one.
        if !seen_names.insert(name.clone()) {
            continue;
        }
        let mut p = detected(
            format!("local:{name}"),
            name,
            ProfileKind::Local,
            path.clone(),
            vec!["-l".into()],
        );
        p.description = Some(path);
        out.push(p);
    }
    out
}

fn detect_local() -> Vec<Profile> {
    if cfg!(windows) {
        let mut out = Vec::new();
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let cmd = format!(r"{system_root}\System32\cmd.exe");
        if Path::new(&cmd).exists() {
            out.push(detected(
                "local:cmd".into(),
                "Wiersz polecenia".into(),
                ProfileKind::Local,
                cmd,
                vec![],
            ));
        }
        for git_bash in [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ] {
            if Path::new(git_bash).exists() {
                out.push(detected(
                    "local:git-bash".into(),
                    "Git Bash".into(),
                    ProfileKind::Local,
                    git_bash.into(),
                    vec!["--login".into(), "-i".into()],
                ));
                break;
            }
        }
        return out;
    }
    let content = std::fs::read_to_string("/etc/shells").unwrap_or_default();
    let login = std::env::var("SHELL").ok();
    let mut shells = parse_etc_shells(&content);
    if shells.is_empty() {
        shells = vec!["/bin/bash".into(), "/bin/sh".into()];
    }
    local_unix_profiles(&shells, login.as_deref(), |p| Path::new(p).is_file())
}

// ---------------------------------------------------------------- PowerShell

fn detect_powershell() -> Vec<Profile> {
    let mut out = Vec::new();
    let pwsh_name = if cfg!(windows) { "pwsh.exe" } else { "pwsh" };
    let pwsh = find_in_path(pwsh_name).or_else(|| {
        cfg!(windows)
            .then(|| PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe"))
            .filter(|p| p.is_file())
    });
    if let Some(path) = pwsh {
        let mut p = detected(
            "powershell:pwsh".into(),
            "PowerShell".into(),
            ProfileKind::Powershell,
            path.to_string_lossy().into_owned(),
            vec!["-NoLogo".into()],
        );
        p.description = Some("PowerShell 7".into());
        out.push(p);
    }
    if cfg!(windows) {
        let mut p = detected(
            "powershell:windows".into(),
            "Windows PowerShell".into(),
            ProfileKind::Powershell,
            "powershell.exe".into(),
            vec!["-NoLogo".into()],
        );
        p.description = Some("PowerShell 5.1".into());
        out.push(p);
    }
    out
}

// ---------------------------------------------------------------- WSL

/// Decodes the output of `wsl.exe -l -q`, which is UTF-16LE (often with a BOM and NULs).
pub fn parse_wsl_list(bytes: &[u8]) -> Vec<String> {
    let looks_utf16 = bytes.starts_with(&[0xFF, 0xFE])
        || (bytes.len() >= 2 && bytes.iter().skip(1).step_by(2).take(8).all(|&b| b == 0));
    let text = if looks_utf16 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.lines()
        .map(|l| {
            l.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0')
                .to_string()
        })
        .filter(|l| !l.is_empty())
        // Docker Desktop's internal distributions are not meant for interactive use.
        .filter(|l| !l.starts_with("docker-desktop"))
        .collect()
}

pub fn wsl_profiles(distros: &[String]) -> Vec<Profile> {
    distros
        .iter()
        .map(|d| {
            let mut p = detected(
                format!("wsl:{d}"),
                d.clone(),
                ProfileKind::Wsl,
                "wsl.exe".into(),
                vec!["-d".into(), d.clone(), "--cd".into(), "~".into()],
            );
            p.description = Some("WSL".into());
            p
        })
        .collect()
}

#[cfg(windows)]
fn detect_wsl() -> Vec<Profile> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("wsl.exe")
        .args(["-l", "-q"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(o) if o.status.success() => wsl_profiles(&parse_wsl_list(&o.stdout)),
        _ => Vec::new(),
    }
}

#[cfg(not(windows))]
fn detect_wsl() -> Vec<Profile> {
    Vec::new()
}

// ---------------------------------------------------------------- SSH config

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SshConfigHost {
    pub alias: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
}

/// Parses `Host` blocks of an OpenSSH client config. Wildcard / negated patterns are skipped
/// (they are defaults, not hosts). `Include` directives are resolved through `include`.
pub fn parse_ssh_config(
    content: &str,
    include: &mut dyn FnMut(&str) -> Vec<String>,
) -> Vec<SshConfigHost> {
    let mut hosts: Vec<SshConfigHost> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (
                k.to_ascii_lowercase(),
                v.trim_start_matches(|c: char| c.is_whitespace() || c == '=')
                    .trim(),
            ),
            None => continue,
        };
        let value = value.trim_matches('"');
        match key.as_str() {
            "host" => {
                current.clear();
                for alias in value.split_whitespace() {
                    if alias.contains(['*', '?', '!']) || hosts.iter().any(|h| h.alias == alias) {
                        continue;
                    }
                    hosts.push(SshConfigHost {
                        alias: alias.to_string(),
                        ..Default::default()
                    });
                    current.push(hosts.len() - 1);
                }
            }
            "match" => current.clear(),
            "include" => {
                for path in value.split_whitespace() {
                    for inner in include(path) {
                        for h in parse_ssh_config(&inner, include) {
                            if !hosts.iter().any(|x| x.alias == h.alias) {
                                hosts.push(h);
                            }
                        }
                    }
                }
            }
            "hostname" | "user" | "port" => {
                for &i in &current {
                    let h = &mut hosts[i];
                    match key.as_str() {
                        "hostname" if h.host_name.is_none() => {
                            h.host_name = Some(value.to_string())
                        }
                        "user" if h.user.is_none() => h.user = Some(value.to_string()),
                        "port" if h.port.is_none() => h.port = value.parse().ok(),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    hosts
}

/// Resolves an `Include` argument (relative to `~/.ssh`, `~` expanded, `*` in the file name) to file contents.
fn read_ssh_include(ssh_dir: &Path, pattern: &str) -> Vec<String> {
    let expanded = match pattern.strip_prefix("~/") {
        Some(rest) => home_dir()
            .map(|h| h.join(rest))
            .unwrap_or_else(|| PathBuf::from(pattern)),
        None if Path::new(pattern).is_absolute() => PathBuf::from(pattern),
        None => ssh_dir.join(pattern),
    };
    let file_pattern = expanded
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let Some(dir) = expanded.parent() else {
        return Vec::new();
    };
    if !file_pattern.contains('*') {
        return std::fs::read_to_string(&expanded).into_iter().collect();
    }
    let (prefix, suffix) = file_pattern.split_once('*').unwrap_or((&file_pattern, ""));
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            p.is_file()
                && name.starts_with(prefix)
                && name.ends_with(suffix)
                && name.len() >= prefix.len() + suffix.len()
        })
        .collect();
    files.sort();
    files
        .iter()
        .filter_map(|f| std::fs::read_to_string(f).ok())
        .collect()
}

pub fn ssh_config_profiles(hosts: &[SshConfigHost]) -> Vec<Profile> {
    hosts
        .iter()
        .map(|h| {
            let mut p = detected(
                format!("ssh-config:{}", h.alias),
                h.alias.clone(),
                ProfileKind::Ssh,
                "ssh".into(),
                vec![h.alias.clone()],
            );
            let user = h
                .user
                .as_deref()
                .map(|u| format!("{u}@"))
                .unwrap_or_default();
            let host = h.host_name.as_deref().unwrap_or(&h.alias);
            let port = h.port.map(|p| format!(":{p}")).unwrap_or_default();
            p.description = Some(format!("{user}{host}{port} · ~/.ssh/config"));
            p
        })
        .collect()
}

fn detect_ssh_config() -> Vec<Profile> {
    let Some(ssh_dir) = home_dir().map(|h| h.join(".ssh")) else {
        return Vec::new();
    };
    let Ok(content) = std::fs::read_to_string(ssh_dir.join("config")) else {
        return Vec::new();
    };
    let mut depth = 0;
    let mut include = |pattern: &str| {
        depth += 1;
        if depth > 16 {
            return Vec::new(); // include loop guard
        }
        read_ssh_include(&ssh_dir, pattern)
    };
    ssh_config_profiles(&parse_ssh_config(&content, &mut include))
}

/// All profiles detected on this machine, grouped by kind.
pub fn detect_all() -> Vec<Profile> {
    let mut out = detect_local();
    out.extend(detect_wsl());
    out.extend(detect_powershell());
    out.extend(detect_ssh_config());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_etc_shells() {
        let content = "# comment\n/bin/sh\n/bin/bash\n/usr/bin/rbash\n/usr/sbin/nologin\n\n/usr/bin/tmux\n/usr/bin/zsh\n";
        assert_eq!(
            parse_etc_shells(content),
            ["/bin/sh", "/bin/bash", "/usr/bin/zsh"]
        );
    }

    #[test]
    fn local_profiles_put_login_shell_first_and_dedupe_names() {
        let shells: Vec<String> = [
            "/bin/sh",
            "/bin/bash",
            "/usr/bin/bash",
            "/usr/bin/zsh",
            "/opt/missing",
        ]
        .map(String::from)
        .to_vec();
        let profiles = local_unix_profiles(&shells, Some("/usr/bin/zsh"), |p| p != "/opt/missing");
        let ids: Vec<_> = profiles.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["local:zsh", "local:sh", "local:bash"]);
        assert_eq!(profiles[2].command, "/bin/bash");
        assert_eq!(profiles[0].args, ["-l"]);
    }

    fn utf16(s: &str, bom: bool) -> Vec<u8> {
        let mut out = if bom { vec![0xFF, 0xFE] } else { vec![] };
        for u in s.encode_utf16() {
            out.extend(u.to_le_bytes());
        }
        out
    }

    #[test]
    fn parses_wsl_list_in_utf16_and_utf8() {
        let raw = "Ubuntu-22.04\r\ndocker-desktop\r\nDebian\r\n\r\n";
        assert_eq!(
            parse_wsl_list(&utf16(raw, true)),
            ["Ubuntu-22.04", "Debian"]
        );
        assert_eq!(
            parse_wsl_list(&utf16(raw, false)),
            ["Ubuntu-22.04", "Debian"]
        );
        assert_eq!(parse_wsl_list(raw.as_bytes()), ["Ubuntu-22.04", "Debian"]);
        assert!(parse_wsl_list(&[]).is_empty());
    }

    #[test]
    fn builds_wsl_profiles() {
        let p = &wsl_profiles(&["Ubuntu".into()])[0];
        assert_eq!(p.id, "wsl:Ubuntu");
        assert_eq!(p.command, "wsl.exe");
        assert_eq!(p.args, ["-d", "Ubuntu", "--cd", "~"]);
    }

    #[test]
    fn parses_ssh_config_hosts() {
        let config = r#"
# defaults
Host *
    ServerAliveInterval 30
    User everyone

Host prod prod-alias
    HostName 10.0.0.5
    User deploy
    Port 2222

Host dev.example.com
  user=me

Host !bad *.internal staging
    HostName staging.local
Match host foo
    User ignored
Include conf.d/*
"#;
        let mut includes = |p: &str| {
            assert_eq!(p, "conf.d/*");
            vec![
                "Host extra\n  HostName extra.example.com\nHost prod\n  HostName dup\n".to_string(),
            ]
        };
        let hosts = parse_ssh_config(config, &mut includes);
        let aliases: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(
            aliases,
            ["prod", "prod-alias", "dev.example.com", "staging", "extra"]
        );
        assert_eq!(
            hosts[0],
            SshConfigHost {
                alias: "prod".into(),
                host_name: Some("10.0.0.5".into()),
                user: Some("deploy".into()),
                port: Some(2222)
            }
        );
        assert_eq!(hosts[1].host_name.as_deref(), Some("10.0.0.5"));
        assert_eq!(hosts[2].user.as_deref(), Some("me"));
        assert_eq!(hosts[3].host_name.as_deref(), Some("staging.local"));
        assert_eq!(
            hosts[3].user, None,
            "Match block must not leak into the previous Host"
        );
    }

    #[test]
    fn ssh_config_profiles_connect_by_alias() {
        let hosts = vec![SshConfigHost {
            alias: "prod".into(),
            host_name: Some("10.0.0.5".into()),
            user: Some("deploy".into()),
            port: Some(2222),
        }];
        let p = &ssh_config_profiles(&hosts)[0];
        assert_eq!(
            (p.id.as_str(), p.command.as_str()),
            ("ssh-config:prod", "ssh")
        );
        assert_eq!(p.args, ["prod"]);
        assert_eq!(
            p.description.as_deref(),
            Some("deploy@10.0.0.5:2222 · ~/.ssh/config")
        );
    }

    #[test]
    fn reads_includes_with_wildcards() {
        let dir = std::env::temp_dir().join(format!("lf-ssh-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("conf.d")).unwrap();
        std::fs::write(dir.join("conf.d/a.conf"), "Host a").unwrap();
        std::fs::write(dir.join("conf.d/b.conf"), "Host b").unwrap();
        std::fs::write(dir.join("conf.d/notes.txt"), "Host c").unwrap();
        assert_eq!(
            read_ssh_include(&dir, "conf.d/*.conf"),
            ["Host a", "Host b"]
        );
        assert_eq!(read_ssh_include(&dir, "conf.d/a.conf"), ["Host a"]);
        assert!(read_ssh_include(&dir, "missing").is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
