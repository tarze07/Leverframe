//! Agy (Antigravity CLI) transcripts: `~/.gemini/antigravity-cli/brain/<conversation id>/
//! .system_generated/logs/transcript_full.jsonl` (the untruncated twin of `transcript.jsonl`).
//!
//! One line per step: `source` (`USER_EXPLICIT`, `MODEL`, `SYSTEM`), `type` (`USER_INPUT`,
//! `PLANNER_RESPONSE`, `GENERIC`, …), `created_at`, `content`, `thinking`, `tool_calls[]`
//! (`name`, `args`). A tool's output is the `content` of the `MODEL`/`GENERIC` step after the
//! call. The format is not versioned: unknown fields and kinds of steps are tolerated.

use serde_json::Value;

use super::model::{parse_rfc3339, title_from, truncate, LogEntry};

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AgyHead {
    pub title: Option<String>,
    pub started_at: Option<i64>,
}

/// Text of a field that may be a string, a list of parts or an object with text.
fn text_of(v: Option<&Value>) -> Option<String> {
    let text = match v? {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|i| text_of(Some(i)))
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(o) => ["text", "content", "message", "value"]
            .iter()
            .find_map(|k| text_of(o.get(*k)))?,
        _ => return None,
    };
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// `created_at`: RFC 3339, Unix seconds or milliseconds, or `{seconds, nanos}`.
fn time_of(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::String(s) => parse_rfc3339(s),
        Value::Number(n) => {
            let n = n.as_f64()?;
            Some(if n > 1e12 {
                n as i64
            } else {
                (n * 1000.0) as i64
            })
        }
        Value::Object(o) => {
            let s = o.get("seconds").and_then(|s| {
                s.as_i64()
                    .or_else(|| s.as_str().and_then(|x| x.parse().ok()))
            })?;
            let ns = o.get("nanos").and_then(Value::as_i64).unwrap_or(0);
            Some(s * 1000 + ns / 1_000_000)
        }
        _ => None,
    }
}

fn kind(line: &Value) -> (&str, &str) {
    (
        line.get("source").and_then(Value::as_str).unwrap_or(""),
        line.get("type").and_then(Value::as_str).unwrap_or(""),
    )
}

fn is_user(line: &Value) -> bool {
    let (source, kind) = kind(line);
    source.starts_with("USER") && kind == "USER_INPUT"
}

/// The beginning of a transcript: title (first user message) and start time.
pub fn read_head<'a>(lines: impl Iterator<Item = &'a str>) -> AgyHead {
    let mut head = AgyHead::default();
    for raw in lines {
        let Ok(line) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        head.started_at = head.started_at.or_else(|| time_of(line.get("created_at")));
        if is_user(&line) {
            head.title = text_of(line.get("content")).and_then(|t| title_from(&t));
        }
        if head.title.is_some() {
            break;
        }
    }
    head
}

/// Arguments of a tool call (an object, or JSON in a string).
fn args_of(call: &Value) -> Value {
    match call.get("args").or_else(|| call.get("arguments")) {
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::String(s.clone())),
        Some(v) => v.clone(),
        None => Value::Null,
    }
}

fn str_arg<'a>(args: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| args.get(*k).and_then(Value::as_str))
}

/// Full timeline: (entries, lines that could not be read).
pub fn parse<'a>(lines: impl Iterator<Item = &'a str>) -> (Vec<LogEntry>, usize) {
    let mut entries = Vec::new();
    let mut skipped = 0;
    // Calls waiting for their output (the next GENERIC steps), oldest first.
    let mut pending: std::collections::VecDeque<String> = Default::default();
    for (n, raw) in lines.enumerate() {
        if raw.trim().is_empty() {
            continue;
        }
        let Ok(line) = serde_json::from_str::<Value>(raw) else {
            skipped += 1;
            continue;
        };
        let ts = time_of(line.get("created_at"));
        let (source, step) = kind(&line);
        if is_user(&line) {
            if let Some(text) = text_of(line.get("content")) {
                entries.push(LogEntry::User { text, ts });
            }
            continue;
        }
        match (source, step) {
            ("MODEL", "GENERIC") => {
                let output = text_of(line.get("content")).unwrap_or_default();
                let call_id = pending
                    .pop_front()
                    .unwrap_or_else(|| format!("agy-{n}-result"));
                let status = line.get("status").and_then(Value::as_str).unwrap_or("");
                entries.push(LogEntry::ToolResult {
                    call_id,
                    output: truncate(output),
                    is_error: status.contains("ERROR") || status.contains("FAIL"),
                    exit_code: None,
                    ts,
                });
            }
            ("MODEL", _) => {
                if let Some(text) = text_of(line.get("thinking")) {
                    entries.push(LogEntry::Thinking { text, ts });
                }
                if let Some(text) = text_of(line.get("content")) {
                    entries.push(LogEntry::Assistant { text, ts });
                }
                for (i, call) in line
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    let name = call
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let input = args_of(call);
                    let command =
                        str_arg(&input, &["CommandLine", "command", "cmd"]).map(String::from);
                    let lower = name.to_ascii_lowercase();
                    let files = if ["write", "replace", "edit", "create"]
                        .iter()
                        .any(|w| lower.contains(w))
                    {
                        str_arg(&input, &["TargetFile", "file_path", "AbsolutePath", "path"])
                            .map(|f| vec![f.to_string()])
                            .unwrap_or_default()
                    } else {
                        Vec::new()
                    };
                    let id = call
                        .get("id")
                        .and_then(Value::as_str)
                        .map(String::from)
                        .unwrap_or_else(|| format!("agy-{n}-{i}"));
                    pending.push_back(id.clone());
                    entries.push(LogEntry::ToolCall {
                        id,
                        name,
                        input,
                        command,
                        files,
                        ts,
                    });
                }
            }
            // Checkpoints, system messages, errors: not part of the conversation.
            _ => {}
        }
    }
    (entries, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOG: &str = include_str!("fixtures/agy.jsonl");

    #[test]
    fn reads_the_title_and_start() {
        let head = read_head(LOG.lines());
        assert_eq!(head.title.as_deref(), Some("Dodaj test dla koszyka"));
        // The first step (a checkpoint) starts the conversation.
        assert_eq!(head.started_at, parse_rfc3339("2026-11-10T08:59:59Z"));
    }

    #[test]
    fn turns_steps_into_a_timeline() {
        let (entries, skipped) = parse(LOG.lines());
        assert_eq!(skipped, 1, "the broken line");
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
                "call",
                "result",
                "result",
                "assistant"
            ]
        );
        let LogEntry::ToolCall {
            name, command, id, ..
        } = &entries[3]
        else {
            unreachable!()
        };
        assert_eq!(
            (name.as_str(), command.as_deref()),
            ("run_command", Some("npm test"))
        );
        let LogEntry::ToolCall { files, .. } = &entries[4] else {
            unreachable!()
        };
        assert_eq!(files, &["/home/me/sklep/src/cart.test.ts"]);
        let LogEntry::ToolResult {
            call_id,
            output,
            is_error,
            ..
        } = &entries[5]
        else {
            unreachable!()
        };
        assert_eq!(
            (call_id, output.as_str(), *is_error),
            (id, "1 passed", false)
        );
        let LogEntry::ToolResult { is_error, .. } = &entries[6] else {
            unreachable!()
        };
        assert!(*is_error);
    }
}
