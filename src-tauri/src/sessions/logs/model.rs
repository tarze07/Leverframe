use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}

impl AgentKind {
    pub fn id(self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
        }
    }
}

/// One conversation from an agent's own log, as shown in the list.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogSummary {
    pub agent: AgentKind,
    /// The agent's own session id (used to resume the session).
    pub native_id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    /// Unix ms of the first entry, if known.
    pub started_at: Option<i64>,
    /// Unix ms of the last change of the log file.
    pub updated_at: i64,
    pub path: String,
    /// `local` or `wsl:<distro>`.
    pub source: String,
    pub size: u64,
}

/// A normalized timeline entry, common to all agents.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LogEntry {
    User {
        text: String,
        ts: Option<i64>,
    },
    Assistant {
        text: String,
        ts: Option<i64>,
    },
    Thinking {
        text: String,
        ts: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        id: String,
        name: String,
        input: Value,
        /// Shell command line, for command-running tools.
        command: Option<String>,
        /// Files written or edited by the tool.
        files: Vec<String>,
        ts: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        call_id: String,
        output: String,
        is_error: bool,
        exit_code: Option<i64>,
        ts: Option<i64>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogDetail {
    pub summary: LogSummary,
    pub entries: Vec<LogEntry>,
    /// Lines that could not be understood (format changes); they are skipped, not fatal.
    pub skipped_lines: usize,
}

/// Tool output is shown in the timeline, not archived: keep it bounded.
pub const MAX_OUTPUT: usize = 20_000;

pub fn truncate(mut s: String) -> String {
    if s.len() > MAX_OUTPUT {
        let mut cut = MAX_OUTPUT;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n… (obcięto)");
    }
    s
}

/// ISO-8601 / RFC 3339 timestamp → Unix ms.
pub fn parse_ts(v: Option<&Value>) -> Option<i64> {
    let s = v?.as_str()?;
    parse_rfc3339(s)
}

/// Minimal RFC 3339 parser (`2025-10-02T12:34:56.789Z`, `+02:00` offsets) – avoids a date crate.
pub fn parse_rfc3339(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (
        num(0..4)?,
        num(5..7)?,
        num(8..10)?,
        num(11..13)?,
        num(14..16)?,
        num(17..19)?,
    );
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        let start = i + 1;
        i = start;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let frac = &s[start..i];
        let digits: String = frac.chars().chain(std::iter::repeat('0')).take(3).collect();
        ms = digits.parse().ok()?;
    }
    let offset_min = match b.get(i) {
        None | Some(b'Z') | Some(b'z') => 0,
        Some(b'+') | Some(b'-') => {
            let sign = if b[i] == b'+' { 1 } else { -1 };
            let oh = num(i + 1..i + 3)?;
            let om = num(i + 4..i + 6).unwrap_or(0);
            sign * (oh * 60 + om)
        }
        _ => return None,
    };
    // Days from civil (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3600 + mi * 60 + se - offset_min * 60) * 1000) + ms)
}

/// First non-empty line, shortened – used for titles.
pub fn title_from(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut t: String = line.chars().take(120).collect();
    if line.chars().count() > 120 {
        t.push('…');
    }
    Some(t)
}

/// Paths in an `apply_patch` patch (`*** Add File: x`, `*** Update File: y`, `*** Delete File: z`).
pub fn patch_files(patch: &str) -> Vec<String> {
    let mut files = Vec::new();
    for line in patch.lines() {
        for prefix in [
            "*** Add File: ",
            "*** Update File: ",
            "*** Delete File: ",
            "*** Move to: ",
        ] {
            if let Some(p) = line.strip_prefix(prefix) {
                let p = p.trim().to_string();
                if !p.is_empty() && !files.contains(&p) {
                    files.push(p);
                }
            }
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_timestamps() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339("2026-11-07T10:15:12.345Z"),
            Some(1_794_046_512_345)
        );
        assert_eq!(
            parse_rfc3339("2026-11-07T12:15:12.345+02:00"),
            Some(1_794_046_512_345)
        );
        assert_eq!(
            parse_rfc3339("2026-11-07T10:15:12.345678Z"),
            Some(1_794_046_512_345)
        );
        assert_eq!(parse_rfc3339("not a date"), None);
    }

    #[test]
    fn truncates_long_output_on_char_boundary() {
        let s = "ż".repeat(MAX_OUTPUT);
        let t = truncate(s);
        assert!(t.len() <= MAX_OUTPUT + 20);
        assert!(t.ends_with("(obcięto)"));
    }

    #[test]
    fn extracts_patch_files_and_titles() {
        let patch = "*** Begin Patch\n*** Update File: src/a.rs\n@@\n-x\n+y\n*** Add File: b.md\n+hi\n*** End Patch";
        assert_eq!(patch_files(patch), ["src/a.rs", "b.md"]);
        assert_eq!(
            title_from("\n  Fix the login bug\nmore").as_deref(),
            Some("Fix the login bug")
        );
    }
}
