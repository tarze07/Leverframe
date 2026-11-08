//! Agent logs on SSH hosts, read on demand with the system `ssh` client (key authentication,
//! BatchMode). One call lists the newest logs with the beginning of each file; reading a log
//! fetches the whole file. Only paths returned by the last listing of that host can be read.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use super::model::{AgentKind, LogDetail, LogSummary};
use super::{claude, codex};
use crate::agents::{detect_command, run_script};
use crate::profiles::{Profile, ProfileKind};

const LIST_TIMEOUT: Duration = Duration::from_secs(40);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Logs listed per host (newest first) and bytes fetched from the start of each for the list.
const MAX_FILES: usize = 100;
const HEAD_BYTES: usize = 32 * 1024;
const MAX_READ_BYTES: usize = 100 * 1024 * 1024;

/// POSIX sh script run on the host. GNU and BSD `stat` are both supported.
pub fn list_script() -> String {
    format!(
        r#"lf_stat() {{ stat -c '%Y %s' "$1" 2>/dev/null || stat -f '%m %z' "$1" 2>/dev/null; }}
lf_files() {{
  for f in "$HOME"/.claude/projects/*/*.jsonl; do [ -f "$f" ] && printf 'claude %s\n' "$f"; done
  xroot="${{CODEX_HOME:-$HOME/.codex}}/sessions"
  [ -d "$xroot" ] && find "$xroot" -type f -name 'rollout-*.jsonl' 2>/dev/null | sed 's/^/codex /'
}}
tab=$(printf '\t')
lf_files | while read -r agent f; do
  set -- $(lf_stat "$f")
  [ -n "$1" ] && printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$agent" "$f"
done | sort -rn | head -n {MAX_FILES} | while IFS="$tab" read -r m s a f; do
  printf '@@LF-FILE@@\t%s\t%s\t%s\t%s\n' "$m" "$s" "$a" "$f"
  head -c {HEAD_BYTES} "$f"
  printf '\n@@LF-END@@\n'
done
"#
    )
}

/// Parses the listing: (summary, agent) per file. Files without a conversation are skipped.
pub fn parse_listing(out: &str, source: &str) -> Vec<LogSummary> {
    let mut result = Vec::new();
    let mut rest = out;
    while let Some(start) = rest.find("@@LF-FILE@@\t") {
        rest = &rest[start + "@@LF-FILE@@\t".len()..];
        let Some((header, body)) = rest.split_once('\n') else {
            break;
        };
        let end = body.find("\n@@LF-END@@").unwrap_or(body.len());
        let mut head = &body[..end];
        rest = &body[end..];
        let parts: Vec<&str> = header.splitn(4, '\t').collect();
        let [mtime, size, agent, path] = parts[..] else {
            continue;
        };
        let agent = match agent {
            "claude" => AgentKind::Claude,
            "codex" => AgentKind::Codex,
            _ => continue,
        };
        // The head was cut at a byte limit: drop the partial last line.
        if head.len() >= HEAD_BYTES {
            head = head.rfind('\n').map(|i| &head[..i]).unwrap_or("");
        }
        let stem = path
            .rsplit('/')
            .next()
            .unwrap_or(path)
            .trim_end_matches(".jsonl")
            .to_string();
        let (native_id, title, cwd, git_branch, started_at) = match agent {
            AgentKind::Claude => {
                let h = claude::read_head(head.lines());
                (
                    h.session_id.unwrap_or(stem),
                    h.title,
                    h.cwd,
                    h.git_branch,
                    h.started_at,
                )
            }
            AgentKind::Codex => {
                let h = codex::read_head(head.lines());
                (
                    h.session_id.unwrap_or(stem),
                    h.title,
                    h.cwd,
                    h.git_branch,
                    h.started_at,
                )
            }
        };
        if title.is_none() && cwd.is_none() {
            continue;
        }
        result.push(LogSummary {
            agent,
            native_id,
            title,
            cwd,
            git_branch,
            started_at,
            updated_at: mtime.trim().parse::<i64>().unwrap_or(0) * 1000,
            path: path.to_string(),
            source: source.to_string(),
            size: size.trim().parse().unwrap_or(0),
        });
    }
    result
}

/// Paths are put in single quotes in a remote shell command: refuse anything that could escape them.
pub fn safe_remote_path(path: &str) -> bool {
    path.starts_with('/') && path.ends_with(".jsonl") && !path.contains(['\'', '\n', '\r', '\0'])
}

/// Remembers which files each SSH source listed (and their agent), to allow reading only those.
#[derive(Default)]
pub struct SshLogs {
    listed: Mutex<HashMap<String, HashMap<String, AgentKind>>>,
}

impl SshLogs {
    pub fn list(&self, profile: &Profile, source: &str) -> Result<Vec<LogSummary>, String> {
        if profile.kind != ProfileKind::Ssh {
            return Err("To nie jest profil SSH".into());
        }
        let out =
            run_script(&detect_command(profile), &list_script(), LIST_TIMEOUT).map_err(|e| {
                format!("{e}. Logi z hostów SSH wymagają logowania kluczem (bez hasła).")
            })?;
        let list = parse_listing(&out, source);
        self.listed.lock().unwrap().insert(
            source.to_string(),
            list.iter().map(|s| (s.path.clone(), s.agent)).collect(),
        );
        Ok(list)
    }

    pub fn read(&self, profile: &Profile, source: &str, path: &str) -> Result<LogDetail, String> {
        let agent = self
            .listed
            .lock()
            .unwrap()
            .get(source)
            .and_then(|m| m.get(path).copied())
            .ok_or("Tego logu nie ma na liście – odśwież listę rozmów")?;
        if !safe_remote_path(path) {
            return Err("Nieprawidłowa ścieżka logu".into());
        }
        let script = format!("head -c {MAX_READ_BYTES} -- '{path}'\n");
        let text = run_script(&detect_command(profile), &script, READ_TIMEOUT)?;
        let (entries, skipped_lines) = match agent {
            AgentKind::Claude => claude::parse(text.lines()),
            AgentKind::Codex => codex::parse(text.lines()),
        };
        let mut summary = parse_listing(
            &format!(
                "@@LF-FILE@@\t0\t{}\t{}\t{path}\n{text}\n@@LF-END@@\n",
                text.len(),
                agent.id()
            ),
            source,
        )
        .pop()
        .ok_or("Log nie zawiera rozmowy")?;
        summary.updated_at = 0;
        Ok(LogDetail {
            summary,
            entries,
            skipped_lines,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listing() -> String {
        let claude = include_str!("fixtures/claude.jsonl");
        let codex = include_str!("fixtures/codex.jsonl");
        format!(
            "Welcome to the server (MOTD)\n\
             @@LF-FILE@@\t1762000000\t2048\tcodex\t/home/me/.codex/sessions/2026/11/04/rollout-x.jsonl\n{codex}\n@@LF-END@@\n\
             @@LF-FILE@@\t1761000000\t4096\tclaude\t/home/me/.claude/projects/-home-me-shop/5f1c.jsonl\n{claude}\n@@LF-END@@\n\
             @@LF-FILE@@\t1760000000\t10\tclaude\t/home/me/.claude/projects/-x/empty.jsonl\n{{\"type\":\"mode\"}}\n@@LF-END@@\n\
             @@LF-FILE@@\t1\t1\tother\t/x.jsonl\n{{}}\n@@LF-END@@\n"
        )
    }

    #[test]
    fn parses_the_remote_listing() {
        let list = parse_listing(&listing(), "ssh:user-1");
        assert_eq!(
            list.len(),
            2,
            "empty logs and unknown agents skipped, MOTD ignored"
        );
        assert_eq!(list[0].agent, AgentKind::Codex);
        assert_eq!(list[0].updated_at, 1_762_000_000_000);
        assert_eq!(list[0].size, 2048);
        assert_eq!(
            list[1].title.as_deref(),
            Some("Napraw testy modułu płatności")
        );
        assert_eq!(list[1].source, "ssh:user-1");
        assert_eq!(
            list[1].path,
            "/home/me/.claude/projects/-home-me-shop/5f1c.jsonl"
        );
    }

    #[test]
    fn rejects_paths_that_could_escape_quotes() {
        assert!(safe_remote_path("/home/me/.claude/projects/-a/b.jsonl"));
        assert!(!safe_remote_path("/home/me/x'; rm -rf ~; '.jsonl"));
        assert!(!safe_remote_path("relative.jsonl"));
        assert!(!safe_remote_path("/etc/passwd"));
    }

    #[test]
    fn reading_requires_a_listed_path() {
        let ssh = SshLogs::default();
        let profile = Profile {
            id: "user-1".into(),
            name: "srv".into(),
            kind: ProfileKind::Ssh,
            command: "ssh".into(),
            args: vec!["srv".into()],
            env: Default::default(),
            cwd: None,
            icon: None,
            description: None,
            ssh: None,
            source: crate::profiles::ProfileSource::User,
        };
        let err = ssh
            .read(
                &profile,
                "ssh:user-1",
                "/home/me/.claude/projects/-a/b.jsonl",
            )
            .unwrap_err();
        assert!(err.contains("odśwież"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn listing_script_runs_in_a_posix_shell() {
        // Run the real script locally against a fake HOME with sample logs.
        let home = std::env::temp_dir().join(format!("lf-ssh-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let claude_dir = home.join(".claude/projects/-home-me-shop");
        let codex_dir = home.join(".codex/sessions/2026/11/04");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&codex_dir).unwrap();
        std::fs::write(
            claude_dir.join("5f1c.jsonl"),
            include_str!("fixtures/claude.jsonl"),
        )
        .unwrap();
        std::fs::write(
            codex_dir.join("rollout-a.jsonl"),
            include_str!("fixtures/codex.jsonl"),
        )
        .unwrap();
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &list_script()])
            .env("HOME", &home)
            .env_remove("CODEX_HOME")
            .output()
            .unwrap();
        let list = parse_listing(&String::from_utf8_lossy(&out.stdout), "ssh:t");
        assert_eq!(
            list.len(),
            2,
            "stdout: {}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert!(list
            .iter()
            .any(|s| s.agent == AgentKind::Claude && s.size > 0));
        assert!(list
            .iter()
            .any(|s| s.agent == AgentKind::Codex && s.updated_at > 0));
        let _ = std::fs::remove_dir_all(home);
    }
}
