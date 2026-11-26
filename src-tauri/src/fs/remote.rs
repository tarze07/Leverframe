//! Folders of another computer (#100): an SSH host or a container (local, or on an SSH host),
//! listed by a small `sh` script run through the profile's own command – the one agent
//! detection uses (`ssh … sh -s`, `docker exec -i … sh -s`). Used to choose the folder on the
//! server instead of typing it.

use std::time::Duration;

use serde::Serialize;

use crate::agents::{detect_command, run_script};
use crate::profiles::{Profile, ProfileKind};

/// At most this many folders are listed (the rest: `truncated`).
pub const MAX_DIRS: usize = 2000;
pub const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirs {
    /// The folder listed (absolute, `~` resolved on the other side).
    pub path: String,
    /// Its parent (`None` for `/`).
    pub parent: Option<String>,
    /// Names of the folders in it, sorted.
    pub dirs: Vec<String>,
    pub truncated: bool,
}

/// `s` as one word for `sh`, in single quotes.
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Paths and names come from the user: no control characters (they would break the listing).
fn check(text: &str, what: &str) -> Result<(), String> {
    if text.chars().any(char::is_control) {
        return Err(format!("{what}: niedozwolone znaki"));
    }
    Ok(())
}

/// Sets `p` to the folder asked for: empty or `~` is the home folder, `~/x` is under it.
fn resolve_snippet(path: &str) -> String {
    format!(
        r#"p={}
case "$p" in
  ""|"~") p="$HOME" ;;
  "~/"*) p="$HOME/${{p#"~/"}}" ;;
esac
"#,
        quote(path)
    )
}

/// The script listing the folders of `path` (`show_hidden`: also names starting with a dot).
pub fn list_script(path: &str, show_hidden: bool) -> Result<String, String> {
    check(path, "Ścieżka")?;
    let globs = if show_hidden { "* .[!.]* ..?*" } else { "*" };
    Ok(format!(
        r#"{resolve}if [ ! -e "$p" ]; then printf 'LF_ERR\tnot-found\t%s\n' "$p"; exit 0; fi
if [ ! -d "$p" ]; then printf 'LF_ERR\tnot-dir\t%s\n' "$p"; exit 0; fi
cd -- "$p" 2>/dev/null || {{ printf 'LF_ERR\tdenied\t%s\n' "$p"; exit 0; }}
printf 'LF_PWD\t%s\n' "$(pwd)"
n=0
for d in {globs}; do
  [ -d "$d" ] || continue
  case "$d" in *'
'*) continue ;; esac
  n=$((n+1))
  if [ "$n" -gt {max} ]; then printf 'LF_MORE\n'; break; fi
  printf 'LF_DIR\t%s\n' "$d"
done
printf 'LF_END\n'
"#,
        resolve = resolve_snippet(path),
        max = MAX_DIRS,
    ))
}

/// The script making the folder `name` in `parent`; prints its path.
pub fn mkdir_script(parent: &str, name: &str) -> Result<String, String> {
    check(parent, "Ścieżka")?;
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err(format!("Nieprawidłowa nazwa folderu: {name}"));
    }
    check(name, "Nazwa")?;
    Ok(format!(
        r#"{resolve}t="$p"/{name}
if [ -e "$t" ]; then printf 'LF_ERR\texists\t%s\n' "$t"; exit 0; fi
mkdir -- "$t" 2>/dev/null || {{ printf 'LF_ERR\tdenied\t%s\n' "$t"; exit 0; }}
cd -- "$t" && printf 'LF_PWD\t%s\n' "$(pwd)"
printf 'LF_END\n'
"#,
        resolve = resolve_snippet(parent),
        name = quote(name),
    ))
}

/// The script writing `content` to `<dir>/<tasks>/<name>` (a task for an agent there, #108;
/// `tasks` is the project's tasks folder, relative, #114); prints the file's absolute path. With
/// `exclude`, in a git repository the folder goes to its `.git/info/exclude` (once).
pub fn put_task_script(
    dir: &str,
    tasks: &str,
    name: &str,
    content: &str,
    exclude: bool,
) -> Result<String, String> {
    check(dir, "Ścieżka")?;
    let tasks = crate::tasks::project_tasks_dir(Some(tasks))?;
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err(format!("Nieprawidłowa nazwa pliku: {name}"));
    }
    check(name, "Nazwa")?;
    // A here-document ending with a line that is not in the text.
    let mut end = String::from("LF_TASK_END");
    while content.lines().any(|l| l == end) {
        end.push('_');
    }
    let body = content.strip_suffix('\n').unwrap_or(content);
    let pattern = format!("/{}", crate::tasks::excluded_pattern(&tasks));
    let git = if exclude {
        format!(
            "if [ -d .git ]; then\n  grep -qxF {p} .git/info/exclude 2>/dev/null || {{ mkdir -p .git/info && printf '%s\\n' {p} >> .git/info/exclude; }}\nfi\n",
            p = quote(&pattern)
        )
    } else {
        String::new()
    };
    Ok(format!(
        r#"{resolve}cd -- "$p" 2>/dev/null || {{ printf 'LF_ERR\tnot-found\t%s\n' "$p"; exit 0; }}
t={tasks}
mkdir -p -- "$t" 2>/dev/null || {{ printf 'LF_ERR\tdenied\t%s\n' "$p/$t"; exit 0; }}
cat > "$t"/{name} <<'{end}' || {{ printf 'LF_ERR\tdenied\t%s\n' "$p/$t"; exit 0; }}
{body}
{end}
{git}printf 'LF_PWD\t%s\n' "$(pwd)/$t/"{name}
printf 'LF_END\n'
"#,
        resolve = resolve_snippet(dir),
        tasks = quote(&tasks),
        name = quote(name),
    ))
}

/// The script printing a file between `LF_FILE` and `LF_END` lines.
pub fn cat_script(path: &str) -> Result<String, String> {
    check(path, "Ścieżka")?;
    Ok(format!(
        r#"{resolve}if [ ! -f "$p" ]; then printf 'LF_ERR\tnot-found\t%s\n' "$p"; exit 0; fi
printf 'LF_FILE\n'
cat -- "$p" || exit 0
printf '\nLF_END\n'
"#,
        resolve = resolve_snippet(path),
    ))
}

/// The text printed by `cat_script` (ends with a newline when the file does).
pub fn parse_file(out: &str, who: &str) -> Result<String, String> {
    if let Some(start) = out.find("LF_FILE\n") {
        let rest = &out[start + "LF_FILE\n".len()..];
        if let Some(end) = rest.rfind("\nLF_END\n") {
            return Ok(rest[..end].to_string());
        }
    }
    parse(out, who)?;
    Err(format!("Brak odpowiedzi z {who}"))
}

/// Writes a task's text into the tasks folder `tasks` under `dir` on the profile's computer;
/// its path there.
pub fn put_task(
    profile: &Profile,
    dir: &str,
    tasks: &str,
    name: &str,
    content: &str,
    exclude: bool,
) -> Result<String, String> {
    let out = run(
        profile,
        &put_task_script(dir, tasks, name, content, exclude)?,
    )?;
    parse(&out, &profile.name).map(|d| d.path)
}

/// A file of the profile's computer.
pub fn read_file(profile: &Profile, path: &str) -> Result<String, String> {
    let out = run(profile, &cat_script(path)?)?;
    parse_file(&out, &profile.name)
}

fn parent_of(path: &str) -> Option<String> {
    if path == "/" {
        return None;
    }
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => Some("/".into()),
        Some(i) => Some(trimmed[..i].into()),
        None => None,
    }
}

/// Reads the script's output; `who` names the other side in error messages.
pub fn parse(out: &str, who: &str) -> Result<RemoteDirs, String> {
    let mut path = None;
    let mut dirs = Vec::new();
    let mut truncated = false;
    let mut ended = false;
    for line in out.lines() {
        let mut parts = line.splitn(3, '\t');
        match (parts.next(), parts.next(), parts.next()) {
            (Some("LF_ERR"), Some(kind), target) => {
                let target = target.unwrap_or_default();
                return Err(match kind {
                    "not-found" => format!("Na {who} nie ma folderu {target}"),
                    "not-dir" => format!("{target} na {who} nie jest folderem"),
                    "exists" => format!("{target} na {who} już istnieje"),
                    _ => format!("Brak dostępu do {target} na {who}"),
                });
            }
            (Some("LF_PWD"), Some(p), _) => path = Some(p.to_string()),
            (Some("LF_DIR"), Some(d), _) => dirs.push(d.to_string()),
            (Some("LF_MORE"), _, _) => truncated = true,
            (Some("LF_END"), _, _) => ended = true,
            _ => {}
        }
    }
    let path = match (path, ended) {
        (Some(p), true) => p,
        _ => return Err(format!("Brak odpowiedzi z {who}")),
    };
    dirs.sort_by_key(|d| d.to_lowercase());
    Ok(RemoteDirs {
        parent: parent_of(&path),
        path,
        dirs,
        truncated,
    })
}

/// Why a profile has no answer, as a hint after the error.
fn hint(profile: &Profile) -> &'static str {
    match profile.kind {
        ProfileKind::Container => "Kontener musi działać – uruchom go w widoku „Kontenery”.",
        _ => "Logowanie przez SSH musi działać kluczem bez hasła, a host być w known_hosts.",
    }
}

fn run(profile: &Profile, script: &str) -> Result<String, String> {
    if !matches!(
        profile.kind,
        ProfileKind::Ssh | ProfileKind::Container | ProfileKind::Wsl
    ) {
        return Err(format!(
            "{} nie jest profilem SSH, WSL ani kontenera",
            profile.name
        ));
    }
    run_script(&detect_command(profile), script, TIMEOUT)
}

/// The folders of `path` on the profile's computer.
pub fn list(profile: &Profile, path: &str, show_hidden: bool) -> Result<RemoteDirs, String> {
    let out = run(profile, &list_script(path, show_hidden)?)?;
    parse(&out, &profile.name).map_err(|e| {
        if e.starts_with("Brak odpowiedzi") {
            format!("{e}. {}", hint(profile))
        } else {
            e
        }
    })
}

/// Makes the folder `name` in `parent` on the profile's computer; returns its listing.
pub fn mkdir(profile: &Profile, parent: &str, name: &str) -> Result<RemoteDirs, String> {
    let out = run(profile, &mkdir_script(parent, name)?)?;
    let made = parse(&out, &profile.name)?;
    list(profile, &made.path, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::process::{Command, Stdio};

    /// Runs a script with the local `sh` (what the other side does), with this HOME.
    #[cfg(unix)]
    fn sh(script: &str, home: &std::path::Path) -> String {
        use std::io::Write;
        let mut child = Command::new("sh")
            .arg("-s")
            .env("HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap()
    }

    #[cfg(unix)]
    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("lf-remote-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn lists_folders_with_odd_names_through_sh() {
        let home = temp("list");
        for d in ["projekty", "Zażółć gęślą", "it's $HOME", ".ukryty", "a\"b"] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        std::fs::write(home.join("plik.txt"), "x").unwrap();
        let listed = parse(&sh(&list_script("~", false).unwrap(), &home), "srv").unwrap();
        assert_eq!(listed.path, home.to_string_lossy());
        assert_eq!(
            listed.dirs,
            ["a\"b", "it's $HOME", "projekty", "Zażółć gęślą"]
        );
        assert_eq!(
            listed.parent.as_deref(),
            home.parent().and_then(|p| p.to_str())
        );
        assert!(!listed.truncated);

        let hidden = parse(&sh(&list_script("", true).unwrap(), &home), "srv").unwrap();
        assert!(hidden.dirs.contains(&".ukryty".to_string()));

        // A path with a quote and `~/…`.
        let inside = parse(
            &sh(&list_script("~/it's $HOME", false).unwrap(), &home),
            "srv",
        )
        .unwrap();
        assert_eq!(inside.path, home.join("it's $HOME").to_string_lossy());
        assert!(inside.dirs.is_empty());

        let err = parse(&sh(&list_script("~/brak", false).unwrap(), &home), "srv").unwrap_err();
        assert!(
            err.contains("nie ma folderu") && err.contains("brak"),
            "{err}"
        );
        let err = parse(
            &sh(&list_script("~/plik.txt", false).unwrap(), &home),
            "srv",
        )
        .unwrap_err();
        assert!(err.contains("nie jest folderem"), "{err}");
        assert!(list_script("a\nb", false).is_err());

        // A new folder: made, then listed; never twice.
        let made = parse(
            &sh(&mkdir_script("~", "nowy folder").unwrap(), &home),
            "srv",
        )
        .unwrap();
        assert_eq!(made.path, home.join("nowy folder").to_string_lossy());
        let err = parse(
            &sh(&mkdir_script("~", "nowy folder").unwrap(), &home),
            "srv",
        )
        .unwrap_err();
        assert!(err.contains("już istnieje"), "{err}");
        for bad in ["", "..", "a/b", "x\ny"] {
            assert!(mkdir_script("~", bad).is_err(), "{bad:?}");
        }
        let _ = std::fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn copies_a_task_and_reads_it_back_through_sh() {
        let home = temp("task");
        let repo = home.join("sklep");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let text = "---\nid: 1\n---\n# Zażółć 'cytat' $HOME `x`\nLF_TASK_END\nkoniec\n";
        let path = parse(
            &sh(
                &put_task_script(
                    "~/sklep",
                    crate::tasks::PROJECT_TASKS_DIR,
                    "1-a.md",
                    text,
                    true,
                )
                .unwrap(),
                &home,
            ),
            "srv",
        )
        .unwrap()
        .path;
        let file = repo.join(".leverframe/tasks/1-a.md");
        assert_eq!(path, file.to_string_lossy());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
        // Again (a new run): overwritten; the exclude line once.
        sh(
            &put_task_script(
                "~/sklep",
                crate::tasks::PROJECT_TASKS_DIR,
                "1-a.md",
                "nowy",
                true,
            )
            .unwrap(),
            &home,
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "nowy\n");
        assert_eq!(
            std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap(),
            "/.leverframe/\n"
        );
        assert_eq!(
            parse_file(&sh(&cat_script(&path).unwrap(), &home), "srv").unwrap(),
            "nowy\n"
        );
        // Not a repository: no .git made.
        std::fs::create_dir_all(home.join("zwykly")).unwrap();
        sh(
            &put_task_script(
                "~/zwykly",
                crate::tasks::PROJECT_TASKS_DIR,
                "2-b.md",
                "b",
                true,
            )
            .unwrap(),
            &home,
        );
        assert!(!home.join("zwykly/.git").exists());
        let err = parse_file(&sh(&cat_script("~/brak.md").unwrap(), &home), "srv").unwrap_err();
        assert!(err.contains("nie ma folderu"), "{err}");
        let err = parse(
            &sh(
                &put_task_script("~/brak", crate::tasks::PROJECT_TASKS_DIR, "x.md", "x", true)
                    .unwrap(),
                &home,
            ),
            "srv",
        )
        .unwrap_err();
        assert!(err.contains("nie ma folderu"), "{err}");
        assert!(
            put_task_script("~", crate::tasks::PROJECT_TASKS_DIR, "../x.md", "x", true).is_err()
        );
        // An own tasks folder (#114), and without the exclude line.
        std::fs::create_dir_all(home.join("inny/.git")).unwrap();
        let path = parse(
            &sh(
                &put_task_script("~/inny", "docs/zadania", "3-c.md", "c", false).unwrap(),
                &home,
            ),
            "srv",
        )
        .unwrap()
        .path;
        assert_eq!(
            path,
            home.join("inny/docs/zadania/3-c.md").to_string_lossy()
        );
        assert!(!home.join("inny/.git/info/exclude").exists());
        sh(
            &put_task_script("~/inny", "docs/zadania", "3-c.md", "c", true).unwrap(),
            &home,
        );
        assert_eq!(
            std::fs::read_to_string(home.join("inny/.git/info/exclude")).unwrap(),
            "/docs/zadania/\n"
        );
        assert!(put_task_script("~", "../poza", "x.md", "x", true).is_err());
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn reads_the_listing_and_its_errors() {
        let out = "motd\nLF_PWD\t/srv/app\nLF_DIR\tsrc\nLF_DIR\tDocs\nLF_MORE\nLF_END\n";
        let listed = parse(out, "srv").unwrap();
        assert_eq!(listed.path, "/srv/app");
        assert_eq!(listed.parent.as_deref(), Some("/srv"));
        assert_eq!(listed.dirs, ["Docs", "src"]);
        assert!(listed.truncated);
        assert_eq!(parse("LF_PWD\t/\nLF_END\n", "srv").unwrap().parent, None);
        assert_eq!(
            parse("LF_PWD\t/home\nLF_END\n", "srv")
                .unwrap()
                .parent
                .as_deref(),
            Some("/")
        );
        // No end marker: the connection failed or the shell did not run the script.
        assert!(parse("", "srv")
            .unwrap_err()
            .starts_with("Brak odpowiedzi z srv"));
        assert!(parse("LF_PWD\t/x\n", "srv").is_err());
        assert!(parse("LF_ERR\tdenied\t/root\n", "srv")
            .unwrap_err()
            .contains("Brak dostępu do /root"));
    }
}
