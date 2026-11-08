use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use super::model::{AgentKind, LogDetail, LogSummary};
use super::{claude, codex};
use crate::pty::home_dir;

/// Bytes read from the start of a log to fill in the list (title, folder, start time).
const HEAD_BYTES: usize = 256 * 1024;
/// Logs larger than this are not opened in the timeline.
const MAX_LOG_BYTES: u64 = 200 * 1024 * 1024;

/// Where an agent keeps its logs in one environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogRoot {
    pub agent: AgentKind,
    pub dir: PathBuf,
}

/// Log directories under a home directory, honouring `CLAUDE_CONFIG_DIR` / `CODEX_HOME` locally.
pub fn roots_in_home(home: &Path, local_env: bool) -> Vec<LogRoot> {
    let env_dir = |k: &str| {
        local_env
            .then(|| std::env::var_os(k))
            .flatten()
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    vec![
        LogRoot {
            agent: AgentKind::Claude,
            dir: env_dir("CLAUDE_CONFIG_DIR")
                .unwrap_or_else(|| home.join(".claude"))
                .join("projects"),
        },
        LogRoot {
            agent: AgentKind::Codex,
            dir: env_dir("CODEX_HOME")
                .unwrap_or_else(|| home.join(".codex"))
                .join("sessions"),
        },
    ]
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_head_text(path: &Path) -> Option<String> {
    let mut buf = Vec::with_capacity(16 * 1024);
    std::fs::File::open(path)
        .ok()?
        .take(HEAD_BYTES as u64)
        .read_to_end(&mut buf)
        .ok()?;
    let truncated = buf.len() >= HEAD_BYTES;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if truncated {
        // Drop the partial last line.
        if let Some(i) = text.rfind('\n') {
            text.truncate(i);
        }
    }
    Some(text)
}

/// Log files of one root: Claude `projects/<dir>/<id>.jsonl`, Codex `sessions/**/rollout-*.jsonl`.
pub fn list_files(root: &LogRoot) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let read = |d: &Path| {
        std::fs::read_dir(d)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
    };
    match root.agent {
        AgentKind::Claude => {
            for project in read(&root.dir).filter(|p| p.is_dir()) {
                out.extend(
                    read(&project)
                        .filter(|p| p.is_file() && p.extension().is_some_and(|e| e == "jsonl")),
                );
            }
        }
        AgentKind::Codex => {
            let mut stack = vec![(root.dir.clone(), 0)];
            while let Some((dir, depth)) = stack.pop() {
                for p in read(&dir) {
                    if p.is_dir() && depth < 4 {
                        stack.push((p, depth + 1));
                    } else if p.is_file() {
                        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                            out.push(p);
                        }
                    }
                }
            }
        }
    }
    out
}

fn summarize(
    root: &LogRoot,
    path: &Path,
    source: &str,
    meta: &std::fs::Metadata,
) -> Option<LogSummary> {
    let head = read_head_text(path)?;
    let file_stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    let (native_id, title, cwd, git_branch, started_at) = match root.agent {
        AgentKind::Claude => {
            let h = claude::read_head(head.lines());
            (
                h.session_id.unwrap_or(file_stem),
                h.title,
                h.cwd,
                h.git_branch,
                h.started_at,
            )
        }
        AgentKind::Codex => {
            let h = codex::read_head(head.lines());
            (
                h.session_id.unwrap_or(file_stem),
                h.title,
                h.cwd,
                h.git_branch,
                h.started_at,
            )
        }
    };
    // Files without any conversation (e.g. only bookkeeping lines) are not worth listing.
    if title.is_none() && cwd.is_none() {
        return None;
    }
    Some(LogSummary {
        agent: root.agent,
        native_id,
        title,
        cwd,
        git_branch,
        started_at,
        updated_at: mtime_ms(meta),
        path: path.to_string_lossy().into_owned(),
        source: source.to_string(),
        size: meta.len(),
    })
}

/// (modified ms, size, summary) – a summary is reused while the file is unchanged.
type CacheEntry = (i64, u64, Option<LogSummary>);

/// Agent logs (Claude Code, Codex) per environment, with a cache keyed by file modification.
#[derive(Default)]
pub struct AgentLogService {
    cache: Mutex<HashMap<PathBuf, CacheEntry>>,
    wsl_homes: Mutex<HashMap<String, PathBuf>>,
    /// Home directory used for `local` instead of the real one (tests).
    home_override: Option<PathBuf>,
    /// Logs on SSH hosts (`ssh:<profile id>` sources).
    pub ssh: super::ssh::SshLogs,
}

impl AgentLogService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_home(home: &Path) -> Self {
        Self {
            home_override: Some(home.to_path_buf()),
            ..Self::default()
        }
    }

    /// Log roots for a source: `local`, or `wsl:<distro>` (Windows: `\\wsl.localhost\<distro>\home\…`).
    pub fn roots(&self, source: &str) -> Result<Vec<LogRoot>, String> {
        if source == "local" {
            let home = self
                .home_override
                .clone()
                .or_else(home_dir)
                .ok_or("Nie znaleziono katalogu domowego")?;
            return Ok(roots_in_home(&home, self.home_override.is_none()));
        }
        let distro = source
            .strip_prefix("wsl:")
            .ok_or_else(|| format!("Nieznane źródło: {source}"))?;
        if distro.is_empty() || distro.contains(['\\', '/', '\0']) {
            return Err("Nieprawidłowa nazwa dystrybucji".into());
        }
        let home = self.wsl_home(distro)?;
        Ok(roots_in_home(&home, false))
    }

    #[cfg(windows)]
    fn wsl_home(&self, distro: &str) -> Result<PathBuf, String> {
        use std::os::windows::process::CommandExt;
        if let Some(h) = self.wsl_homes.lock().unwrap().get(distro) {
            return Ok(h.clone());
        }
        let out = std::process::Command::new("wsl.exe")
            .args(["-d", distro, "-e", "sh", "-c", "printf %s \"$HOME\""])
            .creation_flags(0x0800_0000)
            .output()
            .map_err(|e| format!("wsl.exe: {e}"))?;
        let linux_home = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !out.status.success() || !linux_home.starts_with('/') {
            return Err(format!(
                "Nie udało się odczytać katalogu domowego w {distro}"
            ));
        }
        let path = wsl_unc_path(distro, &linux_home);
        self.wsl_homes
            .lock()
            .unwrap()
            .insert(distro.to_string(), path.clone());
        Ok(path)
    }

    #[cfg(not(windows))]
    fn wsl_home(&self, _distro: &str) -> Result<PathBuf, String> {
        let _ = &self.wsl_homes;
        Err("WSL jest dostępny tylko na Windows".into())
    }

    /// Conversations of all agents in a source, newest first.
    pub fn list(&self, source: &str) -> Result<Vec<LogSummary>, String> {
        let mut out = Vec::new();
        let mut cache = self.cache.lock().unwrap();
        for root in self.roots(source)? {
            for path in list_files(&root) {
                let Ok(meta) = std::fs::metadata(&path) else {
                    continue;
                };
                let key = (mtime_ms(&meta), meta.len());
                let summary = match cache.get(&path) {
                    Some((m, s, summary)) if (*m, *s) == key => summary.clone(),
                    _ => {
                        let summary = summarize(&root, &path, source, &meta);
                        cache.insert(path.clone(), (key.0, key.1, summary.clone()));
                        summary
                    }
                };
                out.extend(summary);
            }
        }
        out.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
        Ok(out)
    }

    /// Full timeline of a log. The path must lie inside one of the source's log directories.
    pub fn read(&self, source: &str, path: &str) -> Result<LogDetail, String> {
        let roots = self.roots(source)?;
        let (root, file) = resolve_inside(&roots, Path::new(path))?;
        let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
        if meta.len() > MAX_LOG_BYTES {
            return Err(format!(
                "Log jest za duży ({} MB)",
                meta.len() / 1024 / 1024
            ));
        }
        let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&bytes);
        let summary = summarize(&root, &file, source, &meta).ok_or("Log nie zawiera rozmowy")?;
        let (entries, skipped_lines) = match root.agent {
            AgentKind::Claude => claude::parse(text.lines()),
            AgentKind::Codex => codex::parse(text.lines()),
        };
        Ok(LogDetail {
            summary,
            entries,
            skipped_lines,
        })
    }

    /// Local roots that exist (for the file watcher).
    pub fn local_roots(&self) -> Vec<PathBuf> {
        self.roots("local")
            .unwrap_or_default()
            .into_iter()
            .map(|r| r.dir)
            .filter(|d| d.is_dir())
            .collect()
    }
}

/// `/home/me` in `Ubuntu` → `\\wsl.localhost\Ubuntu\home\me`.
pub fn wsl_unc_path(distro: &str, linux_path: &str) -> PathBuf {
    let rest = linux_path.trim_start_matches('/').replace('/', "\\");
    PathBuf::from(format!(r"\\wsl.localhost\{distro}\{rest}"))
}

/// Canonicalizes `path` and checks that it is a `.jsonl` file inside one of `roots`
/// (prevents reading arbitrary files through the IPC command).
pub fn resolve_inside(roots: &[LogRoot], path: &Path) -> Result<(LogRoot, PathBuf), String> {
    let file = std::fs::canonicalize(path).map_err(|_| "Plik logu nie istnieje".to_string())?;
    if !file.extension().is_some_and(|e| e == "jsonl") || !file.is_file() {
        return Err("To nie jest plik logu agenta".into());
    }
    for root in roots {
        if let Ok(dir) = std::fs::canonicalize(&root.dir) {
            if file.starts_with(&dir) {
                return Ok((root.clone(), file));
            }
        }
    }
    Err("Plik leży poza katalogami logów agentów".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lf-logs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn setup(home: &Path) {
        let claude = home.join(".claude/projects/-home-me-shop");
        std::fs::create_dir_all(claude.join("5f1c2a9e/subagents")).unwrap();
        std::fs::write(
            claude.join("5f1c2a9e.jsonl"),
            include_str!("fixtures/claude.jsonl"),
        )
        .unwrap();
        std::fs::write(claude.join("5f1c2a9e/subagents/agent-x.jsonl"), "{}").unwrap(); // not listed
        std::fs::write(claude.join("empty.jsonl"), "{\"type\":\"mode\"}\n").unwrap(); // no conversation
        let codex = home.join(".codex/sessions/2026/11/04");
        std::fs::create_dir_all(&codex).unwrap();
        std::fs::write(
            codex.join("rollout-2026-11-04T08-00-00-0199a1b2.jsonl"),
            include_str!("fixtures/codex.jsonl"),
        )
        .unwrap();
        std::fs::write(codex.join("notes.txt"), "x").unwrap();
    }

    #[test]
    fn lists_and_reads_claude_and_codex_logs() {
        let home = temp("list");
        setup(&home);
        let roots = roots_in_home(&home, false);
        let files: usize = roots.iter().map(|r| list_files(r).len()).sum();
        assert_eq!(
            files, 3,
            "claude (2, one empty) + codex (1); subagents and other files skipped"
        );

        let svc = AgentLogService::with_home(&home);
        let list = svc.list("local").unwrap();
        assert_eq!(
            list.len(),
            2,
            "the file without a conversation is not listed"
        );
        let claude = list.iter().find(|s| s.agent == AgentKind::Claude).unwrap();
        assert_eq!(claude.native_id, "5f1c2a9e-1111-4c3b-9d7e-0123456789ab");
        assert_eq!(
            claude.title.as_deref(),
            Some("Napraw testy modułu płatności")
        );
        assert_eq!(claude.source, "local");
        let codex = list.iter().find(|s| s.agent == AgentKind::Codex).unwrap();
        assert_eq!(codex.cwd.as_deref(), Some("/home/me/api"));
        assert_eq!(
            svc.list("local").unwrap(),
            list,
            "cached result is identical"
        );

        let detail = svc.read("local", &claude.path).unwrap();
        assert_eq!(detail.summary.native_id, claude.native_id);
        assert_eq!(detail.skipped_lines, 1);
        assert!(detail.entries.len() >= 10);
        let detail = svc.read("local", &codex.path).unwrap();
        assert!(!detail.entries.is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn reading_is_limited_to_log_directories() {
        let home = temp("resolve");
        setup(&home);
        std::fs::write(home.join("secret.jsonl"), "{}").unwrap();
        std::fs::write(home.join(".claude/projects/-home-me-shop/notes.txt"), "x").unwrap();
        let roots = roots_in_home(&home, false);
        let ok = home.join(".claude/projects/-home-me-shop/5f1c2a9e.jsonl");
        let svc = AgentLogService::with_home(&home);
        assert!(svc
            .read("local", home.join("secret.jsonl").to_str().unwrap())
            .is_err());
        assert_eq!(
            resolve_inside(&roots, &ok).unwrap().0.agent,
            AgentKind::Claude
        );
        assert!(resolve_inside(&roots, &home.join("secret.jsonl")).is_err());
        assert!(
            resolve_inside(&roots, &home.join(".claude/projects/../../secret.jsonl")).is_err(),
            "no traversal"
        );
        assert!(resolve_inside(
            &roots,
            &home.join(".claude/projects/-home-me-shop/notes.txt")
        )
        .is_err());
        assert!(resolve_inside(&roots, &home.join("missing.jsonl")).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn wsl_paths_and_sources() {
        assert_eq!(
            wsl_unc_path("Ubuntu", "/home/me"),
            PathBuf::from(r"\\wsl.localhost\Ubuntu\home\me")
        );
        let svc = AgentLogService::new();
        assert!(svc.roots("ssh:prod").is_err());
        assert!(svc.roots("wsl:../x").is_err());
        assert!(svc.roots("local").is_ok());
    }
}
