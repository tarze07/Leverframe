//! Task list (#104, Z1 #105): each task is a Markdown file with a short header – the same file is
//! handed to an agent. Tasks of the project live in `<project>/.leverframe/tasks/`, global ones
//! in the app's data folder (`<data>/tasks/`). The folder `.leverframe/` stays out of the
//! project's repository: it is added to `.git/info/exclude` (never to the user's `.gitignore`).
//!
//! ```markdown
//! ---
//! id: 7
//! title: "Dodać eksport CSV"
//! status: todo
//! created: 2026-11-25
//! ---
//! # Dodać eksport CSV
//! ```
//!
//! The header is `key: value` lines (a subset of YAML, no dependency); unknown keys are kept as
//! they are when a task is changed. A file without a header is a task too: its title is the
//! first `# heading` or the file name.

pub mod commands;

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Folder of the project's tasks, relative to the project folder.
pub const PROJECT_TASKS_DIR: &str = ".leverframe/tasks";
/// What `.git/info/exclude` gets, relative to the repository's root.
const EXCLUDED: &str = ".leverframe/";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Project,
    Global,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Todo,
    Doing,
    Review,
    Done,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Todo => "todo",
            Status::Doing => "doing",
            Status::Review => "review",
            Status::Done => "done",
        }
    }

    /// Unknown values read as `todo`.
    pub fn parse(s: &str) -> Status {
        match s.trim().to_lowercase().as_str() {
            "doing" => Status::Doing,
            "review" => Status::Review,
            "done" => Status::Done,
            _ => Status::Todo,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: u32,
    pub title: String,
    pub status: Status,
    /// `YYYY-MM-DD` (empty when the header has none).
    pub created: String,
    /// The file's name in its folder – what the commands take to name a task.
    pub file: String,
    /// The file's absolute path.
    pub path: String,
    pub scope: Scope,
    /// Agents started on the task (#109), oldest first.
    pub runs: Vec<TaskRun>,
}

/// One start of an agent on a task, kept in the header's `runs` list.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    /// When it started (ISO 8601, as the frontend gives it).
    pub at: String,
    pub agent: String,
    /// Profile id (empty: the default profile).
    #[serde(default)]
    pub profile: String,
    /// `chat` (conversation mode) or `terminal`.
    pub mode: String,
    /// The working folder (as the agent sees it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// The task's copy on the agent's computer (SSH, container without the folder; #108).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
}

const RUN_FIELDS: [&str; 6] = ["at", "agent", "profile", "mode", "cwd", "remote"];

impl TaskRun {
    fn field(&self, key: &str) -> Option<&str> {
        match key {
            "at" => Some(&self.at),
            "agent" => Some(&self.agent),
            "profile" => Some(&self.profile),
            "mode" => Some(&self.mode),
            "cwd" => self.cwd.as_deref(),
            "remote" => self.remote.as_deref(),
            _ => None,
        }
    }

    /// `  - {at: "…", agent: "…", …}` – a YAML list item with a flow mapping.
    fn line(&self) -> String {
        let fields: Vec<String> = RUN_FIELDS
            .iter()
            .filter_map(|k| self.field(k).map(|v| format!("{k}: {}", quote(v))))
            .collect();
        format!("  - {{{}}}", fields.join(", "))
    }

    /// Reads a line written by `line` (other lines: `None`).
    fn parse(line: &str) -> Option<TaskRun> {
        let inner = line.trim().strip_prefix("- {")?.strip_suffix('}')?;
        let mut run = TaskRun::default();
        let mut rest = inner;
        loop {
            rest = rest.trim_start_matches([' ', ',']);
            if rest.is_empty() {
                break;
            }
            let (key, after) = rest.split_once(':')?;
            let after = after.trim_start();
            let (raw, next) = if let Some(body) = after.strip_prefix('"') {
                // Up to the closing quote (not one escaped with `\`).
                let mut end = None;
                let mut escaped = false;
                for (i, c) in body.char_indices() {
                    match c {
                        _ if escaped => escaped = false,
                        '\\' => escaped = true,
                        '"' => {
                            end = Some(i);
                            break;
                        }
                        _ => {}
                    }
                }
                let end = end?;
                (&after[..end + 2], &body[end + 1..])
            } else {
                let end = after.find(',').unwrap_or(after.len());
                (&after[..end], &after[end..])
            };
            let value = unquote(raw);
            match key.trim() {
                "at" => run.at = value,
                "agent" => run.agent = value,
                "profile" => run.profile = value,
                "mode" => run.mode = value,
                "cwd" => run.cwd = Some(value),
                "remote" => run.remote = Some(value),
                _ => {}
            }
            rest = next;
        }
        (!run.at.is_empty() && !run.agent.is_empty()).then_some(run)
    }
}

/// The lines of the `runs` list: (index of `runs:`, the items after it).
fn runs_span(header: &[String]) -> Option<(usize, usize)> {
    let start = header.iter().position(|l| line_key(l) == Some("runs"))?;
    let items = header[start + 1..]
        .iter()
        .take_while(|l| l.starts_with([' ', '\t']) && l.trim().starts_with('-'))
        .count();
    Some((start, items))
}

fn parse_runs(header: &[String]) -> Vec<TaskRun> {
    runs_span(header).map_or_else(Vec::new, |(start, n)| {
        header[start + 1..start + 1 + n]
            .iter()
            .filter_map(|l| TaskRun::parse(l))
            .collect()
    })
}

/// What `update` changes (`None`: left as it is).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskChange {
    pub title: Option<String>,
    pub status: Option<Status>,
}

// ---------------------------------------------------------------------------------------------
// The header

/// A file split into its header lines and the rest.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Doc {
    /// `None`: no header.
    header: Option<Vec<String>>,
    body: String,
    newline: &'static str,
}

fn split(text: &str) -> Doc {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.split_inclusive('\n');
    let first = lines.next().unwrap_or_default();
    if first.trim_end() == "---" {
        let mut header = Vec::new();
        let mut consumed = first.len();
        for line in lines {
            consumed += line.len();
            let l = line.trim_end_matches(['\n', '\r']);
            if l.trim_end() == "---" {
                return Doc {
                    header: Some(header),
                    body: text[consumed..].to_string(),
                    newline,
                };
            }
            header.push(l.to_string());
        }
    }
    Doc {
        header: None,
        body: text.to_string(),
        newline,
    }
}

fn join_doc(doc: &Doc) -> String {
    let nl = doc.newline;
    match &doc.header {
        None => doc.body.clone(),
        Some(lines) => {
            let mut out = format!("---{nl}");
            for l in lines {
                out.push_str(l);
                out.push_str(nl);
            }
            out.push_str(&format!("---{nl}"));
            out.push_str(&doc.body);
            out
        }
    }
}

/// The key of a header line (`None`: not a `key: value` line, e.g. a comment or a list item).
fn line_key(line: &str) -> Option<&str> {
    let (key, _) = line.split_once(':')?;
    let ok = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    ok.then_some(key)
}

/// A value as written: `"…"` (with `\"` and `\\`), `'…'` (with `''`), or plain (a ` #` comment
/// is cut off).
fn unquote(raw: &str) -> String {
    let raw = raw.trim();
    if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
        let inner = &raw[1..raw.len() - 1];
        let mut out = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some(o) => out.push(o),
                    None => out.push('\\'),
                }
            } else {
                out.push(c);
            }
        }
        return out;
    }
    if raw.len() >= 2 && raw.starts_with('\'') && raw.ends_with('\'') {
        return raw[1..raw.len() - 1].replace("''", "'");
    }
    match raw.find(" #") {
        Some(i) => raw[..i].trim_end().to_string(),
        None => raw.to_string(),
    }
}

/// A title as a header value: always in double quotes (it may hold `:`, `#`, quotes …).
fn quote(value: &str) -> String {
    let clean: String = value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    format!("\"{}\"", clean.replace('\\', "\\\\").replace('"', "\\\""))
}

fn get<'a>(header: &'a [String], key: &str) -> Option<&'a str> {
    header
        .iter()
        .find(|l| line_key(l) == Some(key))
        .map(|l| &l[key.len() + 1..])
}

/// Sets `key` (in place when it is there, else at the end).
fn set(header: &mut Vec<String>, key: &str, value: &str) {
    let line = format!("{key}: {value}");
    match header.iter_mut().find(|l| line_key(l) == Some(key)) {
        Some(l) => *l = line,
        None => header.push(line),
    }
}

/// The number at the start of a file name (`7-eksport.md` → 7).
fn file_number(file: &str) -> Option<u32> {
    let digits: String = file.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// The file name without `.md` and without its leading number.
fn file_title(file: &str) -> String {
    let stem = file.strip_suffix(".md").unwrap_or(file);
    let rest = stem.trim_start_matches(|c: char| c.is_ascii_digit());
    let rest = rest.trim_start_matches(['-', '_', ' ']);
    let name = if rest.is_empty() { stem } else { rest };
    name.replace(['-', '_'], " ")
}

fn first_heading(body: &str) -> Option<String> {
    body.lines()
        .map(str::trim)
        .find_map(|l| l.strip_prefix("# "))
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// Reads a task from its file's text.
pub fn parse_task(text: &str, file: &str, path: &Path, scope: Scope) -> Task {
    let doc = split(text);
    let header = doc.header.clone().unwrap_or_default();
    let value = |k: &str| get(&header, k).map(unquote).filter(|v| !v.is_empty());
    Task {
        id: value("id")
            .and_then(|v| v.parse().ok())
            .or_else(|| file_number(file))
            .unwrap_or(0),
        title: value("title")
            .or_else(|| first_heading(&doc.body))
            .unwrap_or_else(|| file_title(file)),
        status: value("status").map_or(Status::Todo, |s| Status::parse(&s)),
        created: value("created").unwrap_or_default(),
        file: file.to_string(),
        path: path.to_string_lossy().into_owned(),
        scope,
        runs: parse_runs(&header),
    }
}

/// The text with the header changed (made when the file has none; the rest kept).
fn apply(text: &str, task: &Task, change: &TaskChange) -> Result<String, String> {
    let mut doc = split(text);
    let had_header = doc.header.is_some();
    let header = doc.header.get_or_insert_with(Vec::new);
    if !had_header || get(header, "id").is_none() {
        set(header, "id", &task.id.to_string());
    }
    if let Some(title) = &change.title {
        let title = title.trim();
        if title.is_empty() {
            return Err("Tytuł zadania nie może być pusty".into());
        }
        set(header, "title", &quote(title));
    } else if !had_header {
        set(header, "title", &quote(&task.title));
    }
    if let Some(status) = change.status {
        set(header, "status", status.as_str());
    } else if get(header, "status").is_none() {
        set(header, "status", task.status.as_str());
    }
    Ok(join_doc(&doc))
}

// ---------------------------------------------------------------------------------------------
// Files

/// `title` as a file name part: lower case, Polish letters without marks, `-` between words.
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.to_lowercase().chars() {
        let c = match c {
            'ą' => 'a',
            'ć' => 'c',
            'ę' => 'e',
            'ł' => 'l',
            'ń' => 'n',
            'ó' => 'o',
            'ś' => 's',
            'ź' | 'ż' => 'z',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 40 {
            break;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "zadanie".into()
    } else {
        out
    }
}

/// Today (UTC) as `YYYY-MM-DD`.
pub fn today() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    civil_date((secs / 86_400) as i64)
}

/// The date of a day counted from 1970-01-01 (H. Hinnant's algorithm).
fn civil_date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// The text of a new task.
pub fn template(id: u32, title: &str, created: &str) -> String {
    format!(
        "---\nid: {id}\ntitle: {}\nstatus: todo\ncreated: {created}\n---\n# {}\n\n## Opis\n\n\n## Kryteria akceptacji\n\n- \n",
        quote(title),
        title.replace(['\r', '\n'], " ")
    )
}

/// A task's file name given by the frontend: one `.md` file of the folder, nothing else.
fn valid_file(file: &str) -> Result<(), String> {
    let ok = file.ends_with(".md")
        && file.len() > 3
        && !file.starts_with('.')
        && !file.contains(['/', '\\', ':'])
        && !file.chars().any(char::is_control);
    if ok {
        Ok(())
    } else {
        Err(format!("Nieprawidłowa nazwa pliku zadania: {file}"))
    }
}

pub(crate) fn read(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("Nie można odczytać {}: {e}", path.display()))
}

fn write(path: &Path, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|e| format!("Nie można zapisać {}: {e}", path.display()))
}

/// Folders of the two scopes.
#[derive(Debug, Clone)]
pub struct TaskDirs {
    /// The project folder (`None`: none chosen).
    pub project: Option<PathBuf>,
    /// The global tasks' folder (in the app's data folder).
    pub global: PathBuf,
}

impl TaskDirs {
    /// The folder of a scope's tasks (it may not exist yet).
    pub fn dir(&self, scope: Scope) -> Result<PathBuf, String> {
        match scope {
            Scope::Global => Ok(self.global.clone()),
            Scope::Project => self
                .project
                .as_ref()
                .map(|p| p.join(".leverframe").join("tasks"))
                .ok_or_else(|| "Najpierw otwórz folder projektu".to_string()),
        }
    }
}

/// The tasks of a folder, by number (a missing folder has none).
pub fn list(dir: &Path, scope: Scope) -> Result<Vec<Task>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Nie można odczytać {}: {e}", dir.display())),
    };
    let mut tasks = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let file = entry.file_name().to_string_lossy().into_owned();
        if valid_file(&file).is_err() || !path.is_file() {
            continue;
        }
        // An unreadable file is still listed (by its name).
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        tasks.push(parse_task(&text, &file, &path, scope));
    }
    tasks.sort_by(|a, b| a.id.cmp(&b.id).then_with(|| a.file.cmp(&b.file)));
    Ok(tasks)
}

fn next_id(dir: &Path, scope: Scope) -> Result<u32, String> {
    Ok(list(dir, scope)?.iter().map(|t| t.id).max().unwrap_or(0) + 1)
}

/// Makes a new task in `dir`; never overwrites a file.
pub fn create(dir: &Path, scope: Scope, title: &str) -> Result<Task, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Podaj tytuł zadania".into());
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Nie można utworzyć {}: {e}", dir.display()))?;
    let id = next_id(dir, scope)?;
    let file = format!("{id}-{}.md", slug(title));
    let path = dir.join(&file);
    let text = template(id, title, &today());
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes()))
        .map_err(|e| format!("Nie można utworzyć {}: {e}", path.display()))?;
    Ok(parse_task(&text, &file, &path, scope))
}

pub(crate) fn task_path(dir: &Path, file: &str) -> Result<PathBuf, String> {
    valid_file(file)?;
    let path = dir.join(file);
    if !path.is_file() {
        return Err(format!("Nie ma zadania {file}"));
    }
    Ok(path)
}

/// Changes the title or the status in the task's header; its text stays as it is.
pub fn update(dir: &Path, scope: Scope, file: &str, change: &TaskChange) -> Result<Task, String> {
    let path = task_path(dir, file)?;
    let text = read(&path)?;
    let task = parse_task(&text, file, &path, scope);
    let text = apply(&text, &task, change)?;
    write(&path, &text)?;
    Ok(parse_task(&text, file, &path, scope))
}

/// Notes a start of an agent on the task (at the end of `runs`) and sets it to „W toku”.
pub fn add_run(dir: &Path, scope: Scope, file: &str, run: &TaskRun) -> Result<Task, String> {
    if run.at.is_empty()
        || run.agent.is_empty()
        || !["chat", "terminal"].contains(&run.mode.as_str())
    {
        return Err("Nieprawidłowe uruchomienie zadania".into());
    }
    let path = task_path(dir, file)?;
    let text = read(&path)?;
    let task = parse_task(&text, file, &path, scope);
    let text = apply(
        &text,
        &task,
        &TaskChange {
            title: None,
            status: Some(Status::Doing),
        },
    )?;
    let mut doc = split(&text);
    let header = doc.header.get_or_insert_with(Vec::new);
    match runs_span(header) {
        Some((start, n)) => header.insert(start + 1 + n, run.line()),
        None => {
            header.push("runs:".into());
            header.push(run.line());
        }
    }
    let text = join_doc(&doc);
    write(&path, &text)?;
    Ok(parse_task(&text, file, &path, scope))
}

/// Moves a task to another scope's folder, with the next number there.
pub fn move_task(
    from_dir: &Path,
    from: Scope,
    file: &str,
    to_dir: &Path,
    to: Scope,
) -> Result<Task, String> {
    let path = task_path(from_dir, file)?;
    if from == to {
        return Err("Zadanie już jest w tym miejscu".into());
    }
    let text = read(&path)?;
    let task = parse_task(&text, file, &path, from);
    std::fs::create_dir_all(to_dir)
        .map_err(|e| format!("Nie można utworzyć {}: {e}", to_dir.display()))?;
    let id = next_id(to_dir, to)?;
    let new_file = format!("{id}-{}.md", slug(&task.title));
    let target = to_dir.join(&new_file);
    let mut doc = split(&text);
    let header = doc.header.get_or_insert_with(Vec::new);
    set(header, "id", &id.to_string());
    if get(header, "title").is_none() {
        set(header, "title", &quote(&task.title));
    }
    if get(header, "status").is_none() {
        set(header, "status", task.status.as_str());
    }
    let text = join_doc(&doc);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes()))
        .map_err(|e| format!("Nie można utworzyć {}: {e}", target.display()))?;
    if let Err(e) = std::fs::remove_file(&path) {
        let _ = std::fs::remove_file(&target);
        return Err(format!("Nie można przenieść {}: {e}", path.display()));
    }
    Ok(parse_task(&text, &new_file, &target, to))
}

/// Deletes a task: to the system trash, or `permanently`.
pub fn delete(dir: &Path, file: &str, permanently: bool) -> Result<(), String> {
    let path = task_path(dir, file)?;
    crate::fs::delete_entry(dir, &path, permanently).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------
// Keeping `.leverframe/` out of the repository

/// The git folder of a repository's root (`.git`, or the folder a `.git` file points to – a
/// worktree or a submodule – and then the common folder of its worktrees).
fn git_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let dir = root.join(target);
    let common = std::fs::read_to_string(dir.join("commondir"))
        .ok()
        .map(|c| dir.join(c.trim()));
    Some(common.unwrap_or(dir))
}

/// Makes git ignore `<project>/.leverframe/` through the repository's `.git/info/exclude` (the
/// project may be a folder inside the repository). Nothing happens outside a repository or when
/// the line is there. Returns the exclude file when it was changed.
pub fn exclude_from_git(project: &Path) -> Result<Option<PathBuf>, String> {
    let project = project
        .canonicalize()
        .unwrap_or_else(|_| project.to_path_buf());
    let Some((root, git)) = project
        .ancestors()
        .find_map(|dir| git_dir(dir).map(|g| (dir.to_path_buf(), g)))
    else {
        return Ok(None);
    };
    let rel = project.strip_prefix(&root).unwrap_or(Path::new(""));
    let mut pattern = String::from("/");
    for part in rel.components() {
        pattern.push_str(&part.as_os_str().to_string_lossy());
        pattern.push('/');
    }
    pattern.push_str(EXCLUDED);
    let file = git.join("info").join("exclude");
    let text = match std::fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("Nie można odczytać {}: {e}", file.display())),
    };
    if text.lines().any(|l| l.trim() == pattern) {
        return Ok(None);
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Nie można utworzyć {}: {e}", parent.display()))?;
    }
    let mut out = text;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("# Zadania Leverframe (lokalne, poza repozytorium)\n");
    out.push_str(&pattern);
    out.push('\n');
    write(&file, &out)?;
    Ok(Some(file))
}

#[cfg(test)]
mod tests;
