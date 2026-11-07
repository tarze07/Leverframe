//! Claude Code transcripts: `~/.claude/projects/<encoded cwd>/<session id>.jsonl`.
//! One JSON object per line; `user` / `assistant` lines carry `message.content` as a string or a
//! list of blocks (`text`, `thinking`, `tool_use`, `tool_result`). Other line types are ignored.

use serde_json::Value;

use super::model::{parse_ts, title_from, truncate, LogEntry};

/// Tools whose input names files they write.
const FILE_TOOLS: &[&str] = &["Edit", "MultiEdit", "Write", "NotebookEdit"];

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ClaudeHead {
    pub session_id: Option<String>,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub started_at: Option<i64>,
}

fn is_noise(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<local-command")
        || t.starts_with("<command-")
        || t.starts_with("<system-reminder>")
        || t.is_empty()
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                Some("text") => b.get("text").and_then(Value::as_str).map(String::from),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// `Exit code 2\n…` – how failed Bash results start.
fn exit_code_from(text: &str) -> Option<i64> {
    text.strip_prefix("Exit code ")?
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}

fn conversational(line: &Value) -> bool {
    let kind = line.get("type").and_then(Value::as_str);
    matches!(kind, Some("user") | Some("assistant"))
        && !line
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

/// Metadata from the first lines of a transcript (enough for the list).
pub fn read_head<'a>(lines: impl Iterator<Item = &'a str>) -> ClaudeHead {
    let mut head = ClaudeHead::default();
    for raw in lines {
        let Ok(line) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        if head.session_id.is_none() {
            head.session_id = line
                .get("sessionId")
                .and_then(Value::as_str)
                .map(String::from);
        }
        if line.get("type").and_then(Value::as_str) == Some("summary") && head.title.is_none() {
            head.title = line
                .get("summary")
                .and_then(Value::as_str)
                .and_then(title_from);
        }
        if !conversational(&line) {
            continue;
        }
        head.cwd = head
            .cwd
            .or_else(|| line.get("cwd").and_then(Value::as_str).map(String::from));
        head.git_branch = head.git_branch.or_else(|| {
            line.get("gitBranch")
                .and_then(Value::as_str)
                .filter(|b| !b.is_empty())
                .map(String::from)
        });
        head.started_at = head.started_at.or_else(|| parse_ts(line.get("timestamp")));
        let meta = line.get("isMeta").and_then(Value::as_bool).unwrap_or(false);
        if head.title.is_none() && !meta && line.get("type").and_then(Value::as_str) == Some("user")
        {
            if let Some(Value::String(text)) = line.pointer("/message/content") {
                if !is_noise(text) {
                    head.title = title_from(text);
                }
            }
        }
        if head.title.is_some() && head.cwd.is_some() && head.started_at.is_some() {
            break;
        }
    }
    head
}

/// Full timeline. Returns the entries and the number of lines that could not be parsed.
pub fn parse<'a>(lines: impl Iterator<Item = &'a str>) -> (Vec<LogEntry>, usize) {
    let mut entries = Vec::new();
    let mut skipped = 0;
    for raw in lines.filter(|l| !l.trim().is_empty()) {
        let Ok(line) = serde_json::from_str::<Value>(raw) else {
            skipped += 1;
            continue;
        };
        if !conversational(&line) {
            continue;
        }
        let ts = parse_ts(line.get("timestamp"));
        let role = line.get("type").and_then(Value::as_str).unwrap_or_default();
        let meta = line.get("isMeta").and_then(Value::as_bool).unwrap_or(false);
        let Some(content) = line.pointer("/message/content") else {
            continue;
        };
        match content {
            Value::String(text) if role == "user" => {
                if !meta && !is_noise(text) {
                    entries.push(LogEntry::User {
                        text: text.clone(),
                        ts,
                    });
                }
            }
            Value::String(text) => entries.push(LogEntry::Assistant {
                text: text.clone(),
                ts,
            }),
            Value::Array(blocks) => {
                for b in blocks {
                    match b.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let text = b
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            if role == "user" {
                                if !meta && !is_noise(&text) {
                                    entries.push(LogEntry::User { text, ts });
                                }
                            } else if !text.trim().is_empty() {
                                entries.push(LogEntry::Assistant { text, ts });
                            }
                        }
                        Some("thinking") => {
                            let text = b
                                .get("thinking")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            if !text.trim().is_empty() {
                                entries.push(LogEntry::Thinking {
                                    text: text.to_string(),
                                    ts,
                                });
                            }
                        }
                        Some("tool_use") => {
                            let name = b
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("?")
                                .to_string();
                            let input = b.get("input").cloned().unwrap_or(Value::Null);
                            let command = (name == "Bash")
                                .then(|| {
                                    input
                                        .get("command")
                                        .and_then(Value::as_str)
                                        .map(String::from)
                                })
                                .flatten();
                            let files = if FILE_TOOLS.contains(&name.as_str()) {
                                ["file_path", "notebook_path"]
                                    .iter()
                                    .filter_map(|k| {
                                        input.get(*k).and_then(Value::as_str).map(String::from)
                                    })
                                    .collect()
                            } else {
                                Vec::new()
                            };
                            entries.push(LogEntry::ToolCall {
                                id: b
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                name,
                                input,
                                command,
                                files,
                                ts,
                            });
                        }
                        Some("tool_result") => {
                            let output = b.get("content").map(text_of).unwrap_or_default();
                            let is_error =
                                b.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                            let exit_code = if is_error {
                                exit_code_from(&output)
                            } else {
                                None
                            };
                            entries.push(LogEntry::ToolResult {
                                call_id: b
                                    .get("tool_use_id")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                output: truncate(output),
                                is_error,
                                exit_code,
                                ts,
                            });
                        }
                        _ => {} // images, unknown future block types
                    }
                }
            }
            _ => {}
        }
    }
    (entries, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("fixtures/claude.jsonl");

    #[test]
    fn reads_list_metadata_from_the_head() {
        let head = read_head(SAMPLE.lines());
        assert_eq!(
            head.session_id.as_deref(),
            Some("5f1c2a9e-1111-4c3b-9d7e-0123456789ab")
        );
        assert_eq!(
            head.title.as_deref(),
            Some("Napraw testy modułu płatności"),
            "meta lines are skipped"
        );
        assert_eq!(head.cwd.as_deref(), Some("/home/me/shop"));
        assert_eq!(head.git_branch.as_deref(), Some("main"));
        assert_eq!(
            head.started_at,
            super::super::model::parse_rfc3339("2026-11-05T09:00:00.000Z")
        );
    }

    #[test]
    fn parses_the_timeline() {
        let (entries, skipped) = parse(SAMPLE.lines());
        assert_eq!(skipped, 1, "the broken line is counted, not fatal");
        let kinds: Vec<&str> = entries
            .iter()
            .map(|e| match e {
                LogEntry::User { .. } => "user",
                LogEntry::Assistant { .. } => "assistant",
                LogEntry::Thinking { .. } => "thinking",
                LogEntry::ToolCall { .. } => "call",
                LogEntry::ToolResult { .. } => "result",
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "user",
                "thinking",
                "assistant",
                "call",
                "result",
                "call",
                "result",
                "call",
                "result",
                "assistant"
            ],
            "meta and sidechain lines are left out"
        );
        match &entries[3] {
            LogEntry::ToolCall { command, name, .. } => {
                assert_eq!(name, "Bash");
                assert_eq!(command.as_deref(), Some("npm test -- payments"));
            }
            e => panic!("{e:?}"),
        }
        match &entries[4] {
            LogEntry::ToolResult {
                is_error,
                exit_code,
                call_id,
                ..
            } => {
                assert!(*is_error);
                assert_eq!(*exit_code, Some(1));
                assert_eq!(call_id, "toolu_1");
            }
            e => panic!("{e:?}"),
        }
        match &entries[5] {
            LogEntry::ToolCall { files, command, .. } => {
                assert_eq!(files, &["/home/me/shop/src/payments.ts"]);
                assert!(command.is_none());
            }
            e => panic!("{e:?}"),
        }
        match &entries[6] {
            LogEntry::ToolResult { output, .. } => assert_eq!(output, "The file has been updated."),
            e => panic!("{e:?}"),
        }
    }
}
