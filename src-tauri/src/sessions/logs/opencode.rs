//! OpenCode sessions: a SQLite database, `~/.local/share/opencode/opencode.db` (1.x):
//! `session` (id, title, directory, times in ms), `message` (`data`: JSON with `role`) and
//! `part` (`data`: JSON – `text`, `reasoning`, `tool` with `callID`, `state.input`,
//! `state.output`, `state.metadata.exit`, …). Read here with SQLite, and on SSH hosts or in
//! containers with `opencode db "<query>" --format json` (the same rows as JSON).

use std::path::Path;

use serde_json::Value;

use super::model::{title_from, truncate, AgentKind, LogDetail, LogEntry, LogSummary};

/// Database file under the OpenCode data folder.
pub const DB_FILE: &str = "opencode.db";
/// Sessions in the list (subagents' sessions, with a parent, are left out).
pub const LIST_SQL: &str = "SELECT id, title, directory, time_created, time_updated FROM session \
     WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 100";

/// Session ids go into SQL: only plain ones (`ses_…`).
pub fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The parts of a session with their messages, in order.
pub fn read_sql(id: &str) -> Option<String> {
    safe_id(id).then(|| {
        format!(
            "SELECT m.data AS message, p.data AS part FROM part p JOIN message m ON m.id = p.message_id \
             WHERE p.session_id = '{id}' ORDER BY m.time_created, m.id, p.time_created, p.id"
        )
    })
}

fn num(v: Option<&Value>) -> Option<i64> {
    v.and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
}

/// Summaries from the rows of [`LIST_SQL`] (objects with its column names). `path` names a
/// session for reading it again.
pub fn summaries(rows: &[Value], source: &str, path: impl Fn(&str) -> String) -> Vec<LogSummary> {
    rows.iter()
        .filter_map(|r| {
            let id = r.get("id")?.as_str()?;
            if !safe_id(id) {
                return None;
            }
            let started_at = num(r.get("time_created"));
            Some(LogSummary {
                agent: AgentKind::OpenCode,
                native_id: id.to_string(),
                title: r.get("title").and_then(Value::as_str).and_then(title_from),
                cwd: r
                    .get("directory")
                    .and_then(Value::as_str)
                    .filter(|d| !d.is_empty())
                    .map(String::from),
                git_branch: None,
                started_at,
                updated_at: num(r.get("time_updated")).or(started_at).unwrap_or(0),
                path: path(id),
                source: source.to_string(),
                size: 0,
            })
        })
        .collect()
}

/// A JSON column: text with JSON (SQLite) or already parsed.
fn json_of(v: Option<&Value>) -> Option<Value> {
    match v? {
        Value::String(s) => serde_json::from_str(s).ok(),
        v @ Value::Object(_) => Some(v.clone()),
        _ => None,
    }
}

/// Timeline from rows of [`read_sql`] (`message`, `part`): entries and rows not understood.
pub fn parse(rows: &[Value]) -> (Vec<LogEntry>, usize) {
    let mut entries = Vec::new();
    let mut skipped = 0;
    for row in rows {
        let (Some(message), Some(part)) = (json_of(row.get("message")), json_of(row.get("part")))
        else {
            skipped += 1;
            continue;
        };
        let user = message.get("role").and_then(Value::as_str) == Some("user");
        let ts = num(part.pointer("/time/start")).or_else(|| num(message.pointer("/time/created")));
        let text = || {
            part.get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(String::from)
        };
        match part.get("type").and_then(Value::as_str) {
            // Text OpenCode adds itself (e.g. file contents for the model) is not the user's.
            Some("text") if part.get("synthetic").and_then(Value::as_bool) == Some(true) => {}
            Some("text") => {
                if let Some(text) = text() {
                    entries.push(if user {
                        LogEntry::User { text, ts }
                    } else {
                        LogEntry::Assistant { text, ts }
                    });
                }
            }
            Some("reasoning") => {
                if let Some(text) = text() {
                    entries.push(LogEntry::Thinking { text, ts });
                }
            }
            Some("tool") => {
                let id = part
                    .get("callID")
                    .and_then(Value::as_str)
                    .unwrap_or("call")
                    .to_string();
                let name = part
                    .get("tool")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                let state = part.get("state").cloned().unwrap_or(Value::Null);
                let input = state.get("input").cloned().unwrap_or(Value::Null);
                let command = (name == "bash")
                    .then(|| {
                        input
                            .get("command")
                            .and_then(Value::as_str)
                            .map(String::from)
                    })
                    .flatten();
                let files = match name.as_str() {
                    "edit" | "write" | "patch" | "multiedit" => input
                        .get("filePath")
                        .and_then(Value::as_str)
                        .map(|f| vec![f.to_string()])
                        .unwrap_or_default(),
                    _ => Vec::new(),
                };
                entries.push(LogEntry::ToolCall {
                    id: id.clone(),
                    name,
                    input,
                    command,
                    files,
                    ts,
                });
                let status = state.get("status").and_then(Value::as_str).unwrap_or("");
                if matches!(status, "completed" | "error") {
                    let output = state
                        .get("output")
                        .or_else(|| state.get("error"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    entries.push(LogEntry::ToolResult {
                        call_id: id,
                        output: truncate(output),
                        is_error: status == "error",
                        exit_code: num(state.pointer("/metadata/exit")),
                        ts: num(state.pointer("/time/end")).or(ts),
                    });
                }
            }
            // step-start, step-finish, patch, file, agent, … – bookkeeping, not conversation.
            _ => {}
        }
    }
    (entries, skipped)
}

fn open(db: &Path) -> Result<rusqlite::Connection, String> {
    use rusqlite::OpenFlags;
    let conn = rusqlite::Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Nie można otworzyć bazy OpenCode ({}): {e}", db.display()))?;
    // OpenCode may be writing at the same time.
    let _ = conn.busy_timeout(std::time::Duration::from_secs(3));
    Ok(conn)
}

/// Rows of a query as JSON objects (column name → text or number).
fn rows(conn: &rusqlite::Connection, sql: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let mapped = stmt
        .query_map([], |row| {
            let mut obj = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                use rusqlite::types::ValueRef;
                let v = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => Value::from(n),
                    ValueRef::Real(f) => Value::from(f),
                    ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
                    ValueRef::Blob(_) => Value::Null,
                };
                obj.insert(name.clone(), v);
            }
            Ok(Value::Object(obj))
        })
        .map_err(|e| e.to_string())?;
    mapped.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// `<database>#<session id>`: a session in a local database (the path the UI keeps).
pub fn local_path(db: &Path, id: &str) -> String {
    format!("{}#{id}", db.display())
}

/// Sessions in a local database.
pub fn list_db(db: &Path, source: &str) -> Result<Vec<LogSummary>, String> {
    let conn = open(db)?;
    Ok(summaries(&rows(&conn, LIST_SQL)?, source, |id| {
        local_path(db, id)
    }))
}

/// A session from a local database.
pub fn read_db(db: &Path, id: &str, source: &str) -> Result<LogDetail, String> {
    let sql = read_sql(id).ok_or("Nieprawidłowy identyfikator sesji OpenCode")?;
    let conn = open(db)?;
    let summary = summaries(
        &rows(
            &conn,
            &format!("SELECT id, title, directory, time_created, time_updated FROM session WHERE id = '{id}'"),
        )?,
        source,
        |id| local_path(db, id),
    )
    .pop()
    .ok_or("Tej sesji OpenCode już nie ma")?;
    let (entries, skipped_lines) = parse(&rows(&conn, &sql)?);
    Ok(LogDetail {
        summary,
        entries,
        skipped_lines,
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A database like OpenCode 1.19 writes, with rows recorded from a real session (a user
    /// message, a reply with a `bash` call and its output, a final reply).
    pub fn sample_db(path: &Path) {
        let _ = std::fs::remove_file(path);
        let conn = rusqlite::Connection::open(path).unwrap();
        conn.execute_batch(include_str!("fixtures/opencode.sql"))
            .unwrap();
    }

    #[test]
    fn lists_and_reads_a_session() {
        let db = std::env::temp_dir().join(format!("lf-opencode-{}.db", std::process::id()));
        sample_db(&db);
        let list = list_db(&db, "local").unwrap();
        assert_eq!(list.len(), 1, "the subagent's session is not listed");
        let s = &list[0];
        assert_eq!(s.agent, AgentKind::OpenCode);
        assert_eq!(s.native_id, "ses_e121fd48effehMLmxjT6GIY6XY");
        assert_eq!(s.title.as_deref(), Some("Tytuł testowy"));
        assert_eq!(s.cwd.as_deref(), Some("/home/me/sklep"));
        assert_eq!(
            (s.started_at, s.updated_at),
            (Some(1794992253809), 1794992256901)
        );
        assert_eq!(
            s.path,
            format!("{}#ses_e121fd48effehMLmxjT6GIY6XY", db.display())
        );

        let d = read_db(&db, &s.native_id, "local").unwrap();
        assert_eq!(d.skipped_lines, 0);
        let kinds: Vec<&str> = d
            .entries
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
                "assistant"
            ]
        );
        let LogEntry::ToolCall { command, name, .. } = &d.entries[3] else {
            unreachable!()
        };
        assert_eq!(
            (name.as_str(), command.as_deref()),
            ("bash", Some("echo hello-oc"))
        );
        let LogEntry::ToolResult {
            output,
            exit_code,
            is_error,
            ..
        } = &d.entries[4]
        else {
            unreachable!()
        };
        assert_eq!(
            (output.as_str(), *exit_code, *is_error),
            ("hello-oc\n", Some(0), false)
        );
        assert!(read_db(&db, "x'; DROP TABLE session; --", "local").is_err());
        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn rows_from_the_opencode_cli_are_read_the_same() {
        // `opencode db … --format json` returns the JSON columns as text.
        let rows: Vec<Value> = serde_json::from_str(
            r#"[{"message":"{\"role\":\"user\",\"time\":{\"created\":1}}","part":"{\"type\":\"text\",\"text\":\"Cześć\"}"},
                {"message":"{\"role\":\"assistant\"}","part":"{\"type\":\"tool\",\"tool\":\"edit\",\"callID\":\"c\",\"state\":{\"status\":\"error\",\"input\":{\"filePath\":\"/a.ts\"},\"error\":\"nope\"}}"},
                {"message":"x","part":"y"}]"#,
        )
        .unwrap();
        let (entries, skipped) = parse(&rows);
        assert_eq!(skipped, 1);
        assert_eq!(
            entries[0],
            LogEntry::User {
                text: "Cześć".into(),
                ts: Some(1)
            }
        );
        let LogEntry::ToolCall { files, .. } = &entries[1] else {
            unreachable!()
        };
        assert_eq!(files, &["/a.ts"]);
        let LogEntry::ToolResult {
            output, is_error, ..
        } = &entries[2]
        else {
            unreachable!()
        };
        assert_eq!((output.as_str(), *is_error), ("nope", true));
        assert!(read_sql("ses_1").is_some() && read_sql("a b").is_none());
    }
}
