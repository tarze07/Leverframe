//! Agent logs on SSH hosts, read on demand with the system `ssh` client (key authentication,
//! BatchMode), and in Docker containers (`docker exec`). One call lists the newest logs with the
//! beginning of each file; reading a log fetches the whole file. Only paths returned by the last
//! listing of that host or container can be read.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use super::model::{AgentKind, LogDetail, LogSummary};
use super::{agy, claude, codex, opencode};
use crate::agents::{detect_command, run_script, LOGIN_PATH_PRELUDE};
use crate::profiles::{Profile, ProfileKind};

const LIST_TIMEOUT: Duration = Duration::from_secs(40);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Logs listed per host (newest first) and bytes fetched from the start of each for the list.
const MAX_FILES: usize = 100;
const HEAD_BYTES: usize = 32 * 1024;
const MAX_READ_BYTES: usize = 100 * 1024 * 1024;
/// The last line of a listing: without it the host or container did not run the script.
const DONE: &str = "@@LF-DONE@@";

/// OpenCode's database on the host, and its CLI that reads it (`opencode db … --format json`);
/// nothing runs when there is no database (the CLI would create one).
fn opencode_script(sql: &str, begin: &str, end: &str) -> String {
    format!(
        r#"lf_ocdb="${{XDG_DATA_HOME:-$HOME/.local/share}}/opencode/opencode.db"
if [ -f "$lf_ocdb" ]; then
{LOGIN_PATH_PRELUDE}  if command -v opencode >/dev/null 2>&1; then
    printf '{begin}\n'
    opencode db "{sql}" --format json </dev/null 2>/dev/null
    printf '\n{end}\n'
  fi
fi
"#
    )
}

const OC_BEGIN: &str = "@@LF-OPENCODE@@";
const OC_END: &str = "@@LF-OPENCODE-END@@";
/// A session on a host or in a container (its id; the database is OpenCode's own).
const OC_PATH: &str = "opencode:";

/// The JSON rows between two markers of a script's output.
fn json_between(out: &str, begin: &str, end: &str) -> Vec<serde_json::Value> {
    out.split_once(&format!("{begin}\n"))
        .and_then(|(_, rest)| rest.split_once(end))
        .and_then(|(json, _)| serde_json::from_str(json.trim()).ok())
        .unwrap_or_default()
}

/// POSIX sh script run on the host. GNU and BSD `stat` are both supported.
pub fn list_script() -> String {
    format!(
        r#"lf_stat() {{ stat -c '%Y %s' "$1" 2>/dev/null || stat -f '%m %z' "$1" 2>/dev/null; }}
lf_files() {{
  for f in "$HOME"/.claude/projects/*/*.jsonl; do [ -f "$f" ] && printf 'claude %s\n' "$f"; done
  xroot="${{CODEX_HOME:-$HOME/.codex}}/sessions"
  [ -d "$xroot" ] && find "$xroot" -type f -name 'rollout-*.jsonl' 2>/dev/null | sed 's/^/codex /'
  for d in "$HOME"/.gemini/antigravity-cli/brain/*/.system_generated/logs; do
    if [ -f "$d/transcript_full.jsonl" ]; then printf 'agy %s\n' "$d/transcript_full.jsonl"
    elif [ -f "$d/transcript.jsonl" ]; then printf 'agy %s\n' "$d/transcript.jsonl"; fi
  done
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
{opencode}printf '{DONE}\n'
"#,
        opencode = opencode_script(opencode::LIST_SQL, OC_BEGIN, OC_END)
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
            "agy" => AgentKind::Agy,
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
            AgentKind::Agy => {
                let h = agy::read_head(head.lines());
                // brain/<id>/.system_generated/logs/transcript_full.jsonl
                let id = path.rsplit('/').nth(3).map(String::from).unwrap_or(stem);
                (id, h.title, None, None, h.started_at)
            }
            AgentKind::OpenCode => continue,
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
    result.extend(opencode::summaries(
        &json_between(out, OC_BEGIN, OC_END),
        source,
        |id| format!("{OC_PATH}{id}"),
    ));
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
        let hint = match profile.kind {
            ProfileKind::Ssh => "Logi z hostów SSH wymagają logowania kluczem (bez hasła).",
            ProfileKind::Container => "Kontener musi działać – uruchom go w widoku „Kontenery”.",
            _ => return Err("To nie jest profil SSH ani kontenera".into()),
        };
        let out = run_script(&detect_command(profile), &list_script(), LIST_TIMEOUT)
            .map_err(|e| format!("{e}. {hint}"))?;
        if !out.contains(DONE) {
            return Err(format!("Brak odpowiedzi. {hint}"));
        }
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
        if agent == AgentKind::OpenCode {
            return read_opencode(profile, source, path);
        }
        if !safe_remote_path(path) {
            return Err("Nieprawidłowa ścieżka logu".into());
        }
        let script = format!("head -c {MAX_READ_BYTES} -- '{path}'\n");
        let text = run_script(&detect_command(profile), &script, READ_TIMEOUT)?;
        let (entries, skipped_lines) = match agent {
            AgentKind::Claude => claude::parse(text.lines()),
            AgentKind::Codex => codex::parse(text.lines()),
            AgentKind::Agy => agy::parse(text.lines()),
            AgentKind::OpenCode => unreachable!("read above"),
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

/// An OpenCode session on a host or in a container: its summary and parts, read with the
/// host's `opencode db`.
fn read_opencode(profile: &Profile, source: &str, path: &str) -> Result<LogDetail, String> {
    let id = path.strip_prefix(OC_PATH).unwrap_or_default();
    let sql = opencode::read_sql(id).ok_or("Nieprawidłowy identyfikator sesji OpenCode")?;
    let session_sql = format!(
        "SELECT id, title, directory, time_created, time_updated FROM session WHERE id = '{id}'"
    );
    let script = format!(
        "{}{}",
        opencode_script(&session_sql, "@@LF-OC-SESSION@@", "@@LF-OC-SESSION-END@@"),
        opencode_script(&sql, OC_BEGIN, OC_END)
    );
    let out = run_script(&detect_command(profile), &script, READ_TIMEOUT)?;
    let summary = opencode::summaries(
        &json_between(&out, "@@LF-OC-SESSION@@", "@@LF-OC-SESSION-END@@"),
        source,
        |id| format!("{OC_PATH}{id}"),
    )
    .pop()
    .ok_or("Nie udało się odczytać sesji OpenCode (czy `opencode` jest w PATH?)")?;
    let (entries, skipped_lines) = opencode::parse(&json_between(&out, OC_BEGIN, OC_END));
    Ok(LogDetail {
        summary,
        entries,
        skipped_lines,
    })
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
            container: None,
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
        let agy = home.join(".gemini/antigravity-cli/brain/c0ffee-1/.system_generated/logs");
        std::fs::create_dir_all(&agy).unwrap();
        std::fs::write(
            agy.join("transcript_full.jsonl"),
            include_str!("fixtures/agy.jsonl"),
        )
        .unwrap();
        // OpenCode: its database, and a stand-in for its CLI answering `opencode db … --format json`
        // with the database's rows (the real CLI is not installed in tests).
        let oc = home.join(".local/share/opencode");
        std::fs::create_dir_all(&oc).unwrap();
        super::opencode::tests::sample_db(&oc.join("opencode.db"));
        let bin = home.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let rows = r#"[{"id":"ses_e121fd48effehMLmxjT6GIY6XY","title":"Tytuł testowy","directory":"/home/me/sklep","time_created":1794992253809,"time_updated":1794992256901}]"#;
        std::fs::write(
            bin.join("opencode"),
            format!(
                "#!/bin/sh\n[ \"$1\" = db ] && [ \"$3\" = --format ] && printf '%s' '{rows}'\n"
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(bin.join("opencode"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &list_script()])
            .env("HOME", &home)
            .env("SHELL", "/bin/sh")
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env_remove("CODEX_HOME")
            .env_remove("XDG_DATA_HOME")
            .output()
            .unwrap();
        let list = parse_listing(&String::from_utf8_lossy(&out.stdout), "ssh:t");
        assert_eq!(
            list.len(),
            4,
            "stdout: {}",
            String::from_utf8_lossy(&out.stdout)
        );
        let agy_log = list.iter().find(|s| s.agent == AgentKind::Agy).unwrap();
        assert_eq!(agy_log.native_id, "c0ffee-1");
        let oc_log = list
            .iter()
            .find(|s| s.agent == AgentKind::OpenCode)
            .unwrap();
        assert_eq!(oc_log.path, "opencode:ses_e121fd48effehMLmxjT6GIY6XY");
        assert_eq!(oc_log.cwd.as_deref(), Some("/home/me/sklep"));
        assert!(list
            .iter()
            .any(|s| s.agent == AgentKind::Claude && s.size > 0));
        assert!(list
            .iter()
            .any(|s| s.agent == AgentKind::Codex && s.updated_at > 0));
        let _ = std::fs::remove_dir_all(home);
    }
}
