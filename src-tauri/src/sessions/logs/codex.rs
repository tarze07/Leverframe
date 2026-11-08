//! Codex rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`.
//! Current format: `{timestamp, type, payload}` lines (`session_meta`, `response_item`, `event_msg`,
//! `turn_context`). Older versions wrote a bare meta object first and bare response items after it.
//! `function_call_output.output` is plain text – sometimes JSON with `metadata.exit_code`, sometimes
//! text with `Process exited with code N`.

use serde_json::Value;

use super::model::{parse_ts, patch_files, title_from, truncate, LogEntry};

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CodexHead {
    pub session_id: Option<String>,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub started_at: Option<i64>,
}

/// One line as (timestamp, item): envelope lines are unwrapped, legacy lines are used as they are.
fn unwrap_line(line: &Value) -> Option<(Option<i64>, &str, &Value)> {
    let ts = parse_ts(line.get("timestamp"));
    match (
        line.get("type").and_then(Value::as_str),
        line.get("payload"),
    ) {
        (Some(kind), Some(payload)) => Some((ts, kind, payload)),
        (Some(_), None) => Some((ts, "response_item", line)), // legacy response item
        (None, None) if line.get("record_type").is_some() => None,
        (None, None) if line.get("id").is_some() => Some((ts, "session_meta", line)), // legacy meta
        _ => None,
    }
}

/// Text the CLI injects as "user" messages (environment, instructions) – not typed by the user.
fn is_injected(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<environment_context>")
        || t.starts_with("<user_instructions>")
        || t.starts_with("# AGENTS.md")
        || t.starts_with("<permissions")
        || t.is_empty()
}

fn message_text(item: &Value) -> String {
    item.get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|c| c.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// `["bash", "-lc", "npm test"]` → `npm test`; other arrays are joined with spaces.
fn command_line(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => {
            let parts: Vec<&str> = parts.iter().filter_map(Value::as_str).collect();
            match parts.as_slice() {
                [sh, flag, script]
                    if (sh.ends_with("sh") || sh.ends_with("sh.exe"))
                        && flag.starts_with('-')
                        && flag.contains('c') =>
                {
                    Some(script.to_string())
                }
                [] => None,
                _ => Some(parts.join(" ")),
            }
        }
        _ => None,
    }
}

fn output_text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|c| c.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// Splits a tool output into the displayed text and an exit code, if one can be found.
fn interpret_output(raw: String) -> (String, Option<i64>) {
    if let Ok(v) = serde_json::from_str::<Value>(&raw) {
        if let Some(out) = v.get("output").and_then(Value::as_str) {
            let code = v.pointer("/metadata/exit_code").and_then(Value::as_i64);
            return (out.to_string(), code);
        }
    }
    let code = raw.lines().find_map(|l| {
        let l = l.trim();
        l.strip_prefix("Process exited with code ")
            .or_else(|| l.strip_prefix("Exit code: "))
            .and_then(|n| n.trim().parse().ok())
    });
    (raw, code)
}

pub fn read_head<'a>(lines: impl Iterator<Item = &'a str>) -> CodexHead {
    let mut head = CodexHead::default();
    for raw in lines {
        let Ok(line) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        let Some((ts, kind, item)) = unwrap_line(&line) else {
            continue;
        };
        match kind {
            "session_meta" => {
                head.session_id = item.get("id").and_then(Value::as_str).map(String::from);
                head.cwd = item.get("cwd").and_then(Value::as_str).map(String::from);
                head.git_branch = item
                    .pointer("/git/branch")
                    .and_then(Value::as_str)
                    .map(String::from);
                head.started_at = parse_ts(item.get("timestamp")).or(ts);
            }
            "turn_context" if head.cwd.is_none() => {
                head.cwd = item.get("cwd").and_then(Value::as_str).map(String::from);
            }
            "response_item"
                if head.title.is_none()
                    && item.get("type").and_then(Value::as_str) == Some("message")
                    && item.get("role").and_then(Value::as_str) == Some("user") =>
            {
                let text = message_text(item);
                if !is_injected(&text) {
                    head.title = title_from(&text);
                }
            }
            _ => {}
        }
        if head.title.is_some() && head.session_id.is_some() {
            break;
        }
    }
    head
}

pub fn parse<'a>(lines: impl Iterator<Item = &'a str>) -> (Vec<LogEntry>, usize) {
    let mut entries = Vec::new();
    let mut skipped = 0;
    for raw in lines.filter(|l| !l.trim().is_empty()) {
        let Ok(line) = serde_json::from_str::<Value>(raw) else {
            skipped += 1;
            continue;
        };
        let Some((ts, "response_item", item)) = unwrap_line(&line) else {
            continue;
        };
        let call_id = || {
            item.get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                let text = message_text(item);
                match item.get("role").and_then(Value::as_str) {
                    Some("user") if !is_injected(&text) => {
                        entries.push(LogEntry::User { text, ts })
                    }
                    Some("assistant") if !text.trim().is_empty() => {
                        entries.push(LogEntry::Assistant { text, ts })
                    }
                    _ => {}
                }
            }
            Some("reasoning") => {
                let text = item
                    .get("summary")
                    .and_then(Value::as_array)
                    .map(|s| {
                        s.iter()
                            .filter_map(|x| x.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                if !text.trim().is_empty() {
                    entries.push(LogEntry::Thinking { text, ts });
                }
            }
            Some("function_call") => {
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
                    .to_string();
                let args = item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}");
                let input: Value =
                    serde_json::from_str(args).unwrap_or_else(|_| Value::String(args.to_string()));
                let command = ["command", "cmd"]
                    .iter()
                    .find_map(|k| input.get(*k).and_then(command_line));
                let files = if name == "apply_patch" {
                    patch_files(
                        input
                            .get("input")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    )
                } else {
                    Vec::new()
                };
                entries.push(LogEntry::ToolCall {
                    id: call_id(),
                    name,
                    input,
                    command,
                    files,
                    ts,
                });
            }
            Some("local_shell_call") => {
                let input = item.get("action").cloned().unwrap_or(Value::Null);
                let command = input.get("command").and_then(command_line);
                entries.push(LogEntry::ToolCall {
                    id: call_id(),
                    name: "local_shell".into(),
                    input,
                    command,
                    files: Vec::new(),
                    ts,
                });
            }
            Some("custom_tool_call") => {
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
                    .to_string();
                let text = item
                    .get("input")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let files = if name == "apply_patch" {
                    patch_files(text)
                } else {
                    Vec::new()
                };
                entries.push(LogEntry::ToolCall {
                    id: call_id(),
                    name,
                    input: Value::String(text.to_string()),
                    command: None,
                    files,
                    ts,
                });
            }
            Some("function_call_output") | Some("custom_tool_call_output") => {
                let (output, exit_code) = interpret_output(output_text(item.get("output")));
                entries.push(LogEntry::ToolResult {
                    call_id: call_id(),
                    output: truncate(output),
                    is_error: exit_code.is_some_and(|c| c != 0),
                    exit_code,
                    ts,
                });
            }
            _ => {} // web search, images, compaction and future item types
        }
    }
    (entries, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("fixtures/codex.jsonl");
    const LEGACY: &str = include_str!("fixtures/codex-legacy.jsonl");

    #[test]
    fn reads_head_of_current_format() {
        let h = read_head(SAMPLE.lines());
        assert_eq!(
            h.session_id.as_deref(),
            Some("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")
        );
        assert_eq!(
            h.title.as_deref(),
            Some("Dodaj limit zapytań do endpointu /login"),
            "environment context skipped"
        );
        assert_eq!(h.cwd.as_deref(), Some("/home/me/api"));
        assert_eq!(h.git_branch.as_deref(), Some("feature/rate-limit"));
        assert!(h.started_at.is_some());
    }

    #[test]
    fn parses_commands_patches_and_exit_codes() {
        let (entries, skipped) = parse(SAMPLE.lines());
        assert_eq!(skipped, 0);
        let calls: Vec<_> = entries
            .iter()
            .filter_map(|e| match e {
                LogEntry::ToolCall {
                    name,
                    command,
                    files,
                    ..
                } => Some((name.as_str(), command.clone(), files.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(
            calls,
            [
                ("shell", Some("rg -n login src".to_string()), vec![]),
                (
                    "apply_patch",
                    None,
                    vec!["src/routes.ts".to_string(), "src/rateLimit.ts".to_string()]
                ),
                ("exec_command", Some("npm test".to_string()), vec![]),
            ]
        );
        let results: Vec<_> = entries
            .iter()
            .filter_map(|e| match e {
                LogEntry::ToolResult {
                    call_id,
                    exit_code,
                    is_error,
                    output,
                    ..
                } => Some((
                    call_id.as_str(),
                    *exit_code,
                    *is_error,
                    output.lines().next().unwrap_or("").to_string(),
                )),
                _ => None,
            })
            .collect();
        assert_eq!(
            results[0],
            (
                "call_1",
                Some(0),
                false,
                "src/routes.ts:12: router.post('/login'".to_string()
            )
        );
        assert_eq!(results[1].0, "call_2");
        assert_eq!((results[2].1, results[2].2), (Some(2), true));
        assert!(
            matches!(entries.first(), Some(LogEntry::User { .. })),
            "injected context is not a user message"
        );
        assert!(entries
            .iter()
            .any(|e| matches!(e, LogEntry::Thinking { text, .. } if text.contains("strukturę"))));
        assert!(
            matches!(entries.last(), Some(LogEntry::Assistant { .. })),
            "unknown item types ignored"
        );
    }

    #[test]
    fn reads_the_legacy_format() {
        let h = read_head(LEGACY.lines());
        assert_eq!(
            h.session_id.as_deref(),
            Some("6c1f0a52-aaaa-bbbb-cccc-000000000001")
        );
        assert_eq!(h.title.as_deref(), Some("List files"));
        assert_eq!(h.git_branch.as_deref(), Some("main"));
        let (entries, _) = parse(LEGACY.lines());
        assert!(
            matches!(&entries[1], LogEntry::ToolCall { command: Some(c), .. } if c == "ls -la")
        );
        assert!(
            matches!(&entries[2], LogEntry::ToolResult { exit_code: Some(0), output, .. } if output == "total 0")
        );
        assert_eq!(entries.len(), 4);
    }

    #[test]
    fn command_lines() {
        let v = |s: &str| serde_json::from_str::<Value>(s).unwrap();
        assert_eq!(
            command_line(&v(r#"["bash","-lc","ls"]"#)).as_deref(),
            Some("ls")
        );
        assert_eq!(
            command_line(&v(r#"["git","status"]"#)).as_deref(),
            Some("git status")
        );
        assert_eq!(command_line(&v(r#""echo hi""#)).as_deref(), Some("echo hi"));
        assert_eq!(command_line(&v("[]")), None);
    }
}
