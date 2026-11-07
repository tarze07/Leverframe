//! Session index in SQLite: metadata of recorded agent sessions + FTS5 full-text index of their output.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: i64,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub cwd: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub exit_code: Option<i64>,
    pub cast_path: String,
    pub bytes: i64,
    /// Fragment of matching output (only when searching).
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct NewSession {
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub cwd: Option<String>,
    pub started_at: i64,
    pub cast_path: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFilter {
    pub agent_id: Option<String>,
    pub profile_id: Option<String>,
    pub cwd: Option<String>,
    /// Unix ms, inclusive.
    pub from: Option<i64>,
    pub to: Option<i64>,
    /// Full-text query over the recorded output.
    pub query: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Facet {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct Facets {
    pub agents: Vec<Facet>,
    pub profiles: Vec<Facet>,
    pub cwds: Vec<String>,
}

pub struct SessionDb {
    conn: Mutex<Connection>,
}

/// Bump when the schema changes. Version 1: `session_text(text, folded, session_id)`.
const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id     TEXT,
    agent_name   TEXT,
    profile_id   TEXT,
    profile_name TEXT,
    cwd          TEXT,
    started_at   INTEGER NOT NULL,
    ended_at     INTEGER,
    exit_code    INTEGER,
    cast_path    TEXT NOT NULL,
    bytes        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS session_text USING fts5(
    text,
    folded,
    session_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
);
"#;

/// The `unicode61` tokenizer removes diacritics (ą→a, ó→o, …), but `ł` is a separate letter in
/// Unicode, so it is folded by hand – searching "zazolc" finds "Zażółć".
pub fn fold(text: &str) -> String {
    text.replace('ł', "l").replace('Ł', "L")
}

/// Turns user input into a safe FTS5 query: every word quoted, the last one as a prefix.
/// The original text is searched as typed and the `folded` column with `ł`→`l`, so a snippet
/// shows the original wording whenever it matches.
pub fn fts_query(input: &str) -> Option<String> {
    let phrase = |words: Vec<String>| {
        let mut q = words
            .iter()
            .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");
        q.push('*');
        q
    };
    let words: Vec<String> = input.split_whitespace().map(String::from).collect();
    if words.is_empty() {
        return None;
    }
    let folded: Vec<String> = words.iter().map(|w| fold(w)).collect();
    Some(format!(
        "text : ({}) OR folded : ({})",
        phrase(words),
        phrase(folded)
    ))
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRecord> {
    Ok(SessionRecord {
        id: row.get("id")?,
        agent_id: row.get("agent_id")?,
        agent_name: row.get("agent_name")?,
        profile_id: row.get("profile_id")?,
        profile_name: row.get("profile_name")?,
        cwd: row.get("cwd")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        exit_code: row.get("exit_code")?,
        cast_path: row.get("cast_path")?,
        bytes: row.get("bytes")?,
        snippet: row.get("snippet")?,
    })
}

fn err(e: rusqlite::Error) -> String {
    format!("Baza sesji: {e}")
}

impl SessionDb {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        Self::with_connection(Connection::open(path).map_err(err)?)
    }

    pub fn in_memory() -> Result<Self, String> {
        Self::with_connection(Connection::open_in_memory().map_err(err)?)
    }

    fn with_connection(conn: Connection) -> Result<Self, String> {
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
            .map_err(err)?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(err)?;
        if version < SCHEMA_VERSION {
            // The full-text index is derived data: rebuild it when its layout changes.
            conn.execute_batch("DROP TABLE IF EXISTS session_text;")
                .map_err(err)?;
        }
        conn.execute_batch(SCHEMA).map_err(err)?;
        conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))
            .map_err(err)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn insert(&self, s: &NewSession) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (agent_id, agent_name, profile_id, profile_name, cwd, started_at, cast_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![s.agent_id, s.agent_name, s.profile_id, s.profile_name, s.cwd, s.started_at, s.cast_path],
        )
        .map_err(err)?;
        Ok(conn.last_insert_rowid())
    }

    pub fn append_text(&self, id: i64, text: &str) -> Result<(), String> {
        if text.trim().is_empty() {
            return Ok(());
        }
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO session_text (text, folded, session_id) VALUES (?1, ?2, ?3)",
                params![text, fold(text), id],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub fn finish(
        &self,
        id: i64,
        ended_at: i64,
        exit_code: Option<i64>,
        bytes: i64,
    ) -> Result<(), String> {
        self.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE sessions SET ended_at = ?2, exit_code = ?3, bytes = ?4 WHERE id = ?1",
                params![id, ended_at, exit_code, bytes],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// Sessions left open by a crash: close them at the time their file was last written.
    pub fn close_interrupted(
        &self,
        last_modified: impl Fn(&str) -> Option<i64>,
    ) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap();
        let open: Vec<(i64, String, i64)> = conn
            .prepare("SELECT id, cast_path, started_at FROM sessions WHERE ended_at IS NULL")
            .map_err(err)?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        for (id, path, started) in &open {
            let ended = last_modified(path).unwrap_or(*started).max(*started);
            conn.execute(
                "UPDATE sessions SET ended_at = ?2 WHERE id = ?1",
                params![id, ended],
            )
            .map_err(err)?;
        }
        Ok(open.len())
    }

    pub fn get(&self, id: i64) -> Result<Option<SessionRecord>, String> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT *, NULL AS snippet FROM sessions WHERE id = ?1",
                [id],
                row_to_record,
            )
            .optional()
            .map_err(err)
    }

    pub fn list(&self, f: &SessionFilter) -> Result<Vec<SessionRecord>, String> {
        let mut conds: Vec<String> = Vec::new();
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        let mut push = |cond: &str, v: rusqlite::types::Value| {
            args.push(v);
            conds.push(cond.replace('?', &format!("?{}", args.len())));
        };
        if let Some(v) = &f.agent_id {
            push("s.agent_id = ?", v.clone().into());
        }
        if let Some(v) = &f.profile_id {
            push("s.profile_id = ?", v.clone().into());
        }
        if let Some(v) = &f.cwd {
            push("s.cwd = ?", v.clone().into());
        }
        if let Some(v) = f.from {
            push("s.started_at >= ?", v.into());
        }
        if let Some(v) = f.to {
            push("s.started_at <= ?", v.into());
        }
        let query = f.query.as_deref().and_then(fts_query);
        let limit = f.limit.unwrap_or(200).min(1000);
        let where_s = |extra: Option<String>| {
            let mut all = conds.clone();
            all.extend(extra);
            if all.is_empty() {
                String::new()
            } else {
                format!("WHERE {}", all.join(" AND "))
            }
        };
        let sql = match &query {
            Some(q) => {
                // snippet() cannot be used together with GROUP BY, so matches are listed per text chunk
                // (best first within a session) and deduplicated below.
                args.push(q.clone().into());
                let n = args.len();
                format!(
                    "SELECT s.*, m.snippet AS snippet FROM sessions s JOIN (
                         SELECT session_id, snippet(session_text, -1, '[[', ']]', '…', 16) AS snippet, rank
                         FROM session_text WHERE session_text MATCH ?{n}
                     ) m ON m.session_id = s.id {} ORDER BY s.started_at DESC, s.id DESC, m.rank LIMIT {}",
                    where_s(None),
                    limit * 20
                )
            }
            None => format!(
                "SELECT s.*, NULL AS snippet FROM sessions s {} ORDER BY s.started_at DESC, s.id DESC LIMIT {limit}",
                where_s(None)
            ),
        };
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql).map_err(err)?;
        let rows = stmt
            .query_map(params_from_iter(args), row_to_record)
            .map_err(err)?;
        let mut out: Vec<SessionRecord> = Vec::new();
        for row in rows {
            let row = row.map_err(err)?;
            if out.last().map(|r| r.id) != Some(row.id) {
                out.push(row);
            }
            if out.len() >= limit as usize {
                break;
            }
        }
        Ok(out)
    }

    pub fn facets(&self) -> Result<Facets, String> {
        let conn = self.conn.lock().unwrap();
        let pairs = |sql: &str| -> Result<Vec<Facet>, String> {
            conn.prepare(sql)
                .map_err(err)?
                .query_map([], |r| {
                    Ok(Facet {
                        id: r.get(0)?,
                        name: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    })
                })
                .map_err(err)?
                .collect::<Result<_, _>>()
                .map_err(err)
        };
        let agents = pairs(
            "SELECT agent_id, MAX(agent_name) FROM sessions WHERE agent_id IS NOT NULL GROUP BY agent_id ORDER BY 2",
        )?;
        let profiles = pairs(
            "SELECT profile_id, MAX(profile_name) FROM sessions WHERE profile_id IS NOT NULL GROUP BY profile_id ORDER BY 2",
        )?;
        let cwds = conn
            .prepare("SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL ORDER BY cwd")
            .map_err(err)?
            .query_map([], |r| r.get(0))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        Ok(Facets {
            agents,
            profiles,
            cwds,
        })
    }

    /// Deletes rows; returns the cast paths of the deleted sessions.
    pub fn delete(&self, ids: &[i64]) -> Result<Vec<String>, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(err)?;
        let mut paths = Vec::new();
        for id in ids {
            if let Some(p) = tx
                .query_row("SELECT cast_path FROM sessions WHERE id = ?1", [id], |r| {
                    r.get::<_, String>(0)
                })
                .optional()
                .map_err(err)?
            {
                paths.push(p);
            }
            tx.execute("DELETE FROM session_text WHERE session_id = ?1", [id])
                .map_err(err)?;
            tx.execute("DELETE FROM sessions WHERE id = ?1", [id])
                .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        Ok(paths)
    }

    /// Ids of all finished sessions (running ones are kept when clearing history).
    pub fn finished_ids(&self) -> Result<Vec<i64>, String> {
        self.conn
            .lock()
            .unwrap()
            .prepare("SELECT id FROM sessions WHERE ended_at IS NOT NULL")
            .map_err(err)?
            .query_map([], |r| r.get(0))
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(agent: &str, profile: &str, cwd: &str, started_at: i64) -> NewSession {
        NewSession {
            agent_id: Some(agent.into()),
            agent_name: Some(agent.to_uppercase()),
            profile_id: Some(profile.into()),
            profile_name: Some(profile.into()),
            cwd: Some(cwd.into()),
            started_at,
            cast_path: format!("/rec/{started_at}.cast"),
        }
    }

    fn seeded() -> (SessionDb, i64, i64, i64) {
        let db = SessionDb::in_memory().unwrap();
        let a = db
            .insert(&session("claude", "local:bash", "/src/app", 1_000))
            .unwrap();
        let b = db
            .insert(&session("codex", "wsl:Ubuntu", "/src/app", 2_000))
            .unwrap();
        let c = db
            .insert(&session("claude", "local:bash", "/src/other", 3_000))
            .unwrap();
        db.append_text(a, "Running npm test\nAll 42 tests passed")
            .unwrap();
        db.append_text(b, "cargo build --release\nZażółć gęślą jaźń")
            .unwrap();
        db.append_text(c, "git status\nnothing to commit").unwrap();
        db.finish(a, 1_500, Some(0), 120).unwrap();
        (db, a, b, c)
    }

    fn ids(list: &[SessionRecord]) -> Vec<i64> {
        list.iter().map(|s| s.id).collect()
    }

    #[test]
    fn lists_newest_first_with_filters() {
        let (db, a, b, c) = seeded();
        assert_eq!(ids(&db.list(&SessionFilter::default()).unwrap()), [c, b, a]);
        let f = |f: SessionFilter| ids(&db.list(&f).unwrap());
        assert_eq!(
            f(SessionFilter {
                agent_id: Some("claude".into()),
                ..Default::default()
            }),
            [c, a]
        );
        assert_eq!(
            f(SessionFilter {
                profile_id: Some("wsl:Ubuntu".into()),
                ..Default::default()
            }),
            [b]
        );
        assert_eq!(
            f(SessionFilter {
                cwd: Some("/src/app".into()),
                ..Default::default()
            }),
            [b, a]
        );
        assert_eq!(
            f(SessionFilter {
                from: Some(1_500),
                to: Some(2_500),
                ..Default::default()
            }),
            [b]
        );
        let rec = db.get(a).unwrap().unwrap();
        assert_eq!(
            (rec.ended_at, rec.exit_code, rec.bytes),
            (Some(1_500), Some(0), 120)
        );
    }

    #[test]
    fn full_text_search_with_prefix_diacritics_and_snippets() {
        let (db, a, b, _) = seeded();
        let found = db
            .list(&SessionFilter {
                query: Some("npm tes".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(ids(&found), [a]);
        assert!(found[0].snippet.as_deref().unwrap().contains("[[npm]]"));
        // remove_diacritics: "zazolc" finds "Zażółć"
        assert_eq!(
            ids(&db
                .list(&SessionFilter {
                    query: Some("zazolc".into()),
                    ..Default::default()
                })
                .unwrap()),
            [b]
        );
        // Typed with Polish letters: the snippet keeps the original text.
        let typed = db
            .list(&SessionFilter {
                query: Some("Zażółć".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(ids(&typed), [b]);
        assert!(
            typed[0].snippet.as_deref().unwrap().contains("[[Zażółć]]"),
            "{:?}",
            typed[0].snippet
        );
        // search combined with filters
        let q = SessionFilter {
            query: Some("git".into()),
            agent_id: Some("codex".into()),
            ..Default::default()
        };
        assert!(db.list(&q).unwrap().is_empty());
    }

    #[test]
    fn search_input_cannot_break_the_query() {
        let (db, ..) = seeded();
        for q in [
            "\"",
            "a OR",
            "NEAR(",
            "*",
            "-x",
            "col:val",
            "'); DROP TABLE sessions; --",
        ] {
            assert!(
                db.list(&SessionFilter {
                    query: Some(q.into()),
                    ..Default::default()
                })
                .is_ok(),
                "{q}"
            );
        }
        assert_eq!(db.list(&SessionFilter::default()).unwrap().len(), 3);
        assert_eq!(fts_query("  "), None);
        assert_eq!(
            fts_query("a \"ł").as_deref(),
            Some("text : (\"a\" \"\"\"ł\"*) OR folded : (\"a\" \"\"\"l\"*)")
        );
    }

    #[test]
    fn facets_list_known_agents_profiles_and_folders() {
        let (db, ..) = seeded();
        let f = db.facets().unwrap();
        assert_eq!(
            f.agents.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
            ["claude", "codex"]
        );
        assert_eq!(f.agents[0].name, "CLAUDE");
        assert_eq!(f.profiles.len(), 2);
        assert_eq!(f.cwds, ["/src/app", "/src/other"]);
    }

    #[test]
    fn deletes_sessions_and_their_text() {
        let (db, a, b, c) = seeded();
        assert_eq!(db.finished_ids().unwrap(), [a]);
        assert_eq!(
            db.delete(&[a, b]).unwrap(),
            ["/rec/1000.cast", "/rec/2000.cast"]
        );
        assert_eq!(ids(&db.list(&SessionFilter::default()).unwrap()), [c]);
        assert!(db
            .list(&SessionFilter {
                query: Some("npm".into()),
                ..Default::default()
            })
            .unwrap()
            .is_empty());
    }

    #[test]
    fn closes_sessions_interrupted_by_a_crash() {
        let (db, a, b, c) = seeded();
        assert_eq!(
            db.close_interrupted(|p| (p == "/rec/2000.cast").then_some(2_700))
                .unwrap(),
            2
        );
        assert_eq!(db.get(b).unwrap().unwrap().ended_at, Some(2_700));
        assert_eq!(
            db.get(c).unwrap().unwrap().ended_at,
            Some(3_000),
            "no file: start time"
        );
        assert_eq!(
            db.get(a).unwrap().unwrap().ended_at,
            Some(1_500),
            "finished sessions untouched"
        );
    }

    #[test]
    fn rebuilds_an_outdated_text_index() {
        let path = std::env::temp_dir().join(format!("lf-sessions-old-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE VIRTUAL TABLE session_text USING fts5(text, session_id UNINDEXED);",
            )
            .unwrap();
        }
        let db = SessionDb::open(&path).unwrap();
        let id = db.insert(&session("claude", "p", "/x", 1)).unwrap();
        db.append_text(id, "hello world").unwrap();
        assert_eq!(
            db.list(&SessionFilter {
                query: Some("hello".into()),
                ..Default::default()
            })
            .unwrap()
            .len(),
            1
        );
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
        }
    }

    #[test]
    fn persists_on_disk() {
        let path = std::env::temp_dir().join(format!("lf-sessions-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let id = SessionDb::open(&path)
            .unwrap()
            .insert(&session("claude", "p", "/x", 1))
            .unwrap();
        assert!(SessionDb::open(&path).unwrap().get(id).unwrap().is_some());
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
        }
    }
}
