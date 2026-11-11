//! File access for ACP agents (`fs/read_text_file`, `fs/write_text_file`): paths of the agent's
//! file system mapped to this machine, and the check whether a path lies in the session folder.
//!
//! The check resolves `..` and symbolic links (of every existing part of the path), so neither
//! `../../etc/passwd` nor a link inside the project pointing elsewhere counts as "inside".

use std::path::{Component, Path, PathBuf};

/// Whose file system the agent sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsKind {
    /// This machine (Linux, macOS, Windows).
    Local,
    /// A WSL distribution, reached from Windows through `\\wsl.localhost\<distro>`.
    Wsl(String),
}

/// A path the agent sent, as a path on this machine. ACP requires absolute paths.
pub fn to_local(kind: &FsKind, agent_path: &str) -> Result<PathBuf, String> {
    match kind {
        FsKind::Local => {
            let p = PathBuf::from(agent_path);
            if p.is_absolute() {
                Ok(p)
            } else {
                Err(format!("Ścieżka musi być bezwzględna: {agent_path}"))
            }
        }
        FsKind::Wsl(distro) => {
            if !agent_path.starts_with('/') {
                return Err(format!("Ścieżka musi być bezwzględna: {agent_path}"));
            }
            let parts: Vec<&str> = agent_path.split('/').filter(|s| !s.is_empty()).collect();
            // Windows drives are mounted at /mnt/<letter>.
            if parts.len() >= 2
                && parts[0] == "mnt"
                && parts[1].len() == 1
                && parts[1].chars().all(|c| c.is_ascii_alphabetic())
            {
                let mut p = format!("{}:\\", parts[1].to_ascii_uppercase());
                p.push_str(&parts[2..].join("\\"));
                return Ok(PathBuf::from(p));
            }
            Ok(PathBuf::from(format!(
                "\\\\wsl.localhost\\{distro}\\{}",
                parts.join("\\")
            )))
        }
    }
}

/// `.` and `..` resolved without touching the disk (`..` never goes above the root).
pub fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(
                    out.components().next_back(),
                    None | Some(Component::RootDir) | Some(Component::Prefix(_))
                ) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The real location of `p`: symbolic links of its deepest existing ancestor resolved, the rest
/// (not created yet, e.g. a new file) appended.
fn real(p: &Path) -> PathBuf {
    let p = lexical(p);
    let mut existing = p.as_path();
    let mut rest = Vec::new();
    loop {
        if let Ok(c) = std::fs::canonicalize(existing) {
            let mut out = c;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                existing = parent;
            }
            _ => return p,
        }
    }
}

/// Whether `path` lies in one of `roots` (after resolving `..` and symbolic links).
pub fn is_inside(path: &Path, roots: &[PathBuf]) -> bool {
    let path = real(path);
    roots.iter().any(|root| path.starts_with(real(root)))
}

/// Lines `line` (1-based) … `line + limit - 1` of `text`, as `fs/read_text_file` asks.
pub fn slice_lines(text: &str, line: Option<u64>, limit: Option<u64>) -> String {
    if line.is_none() && limit.is_none() {
        return text.to_string();
    }
    let start = line.unwrap_or(1).max(1) as usize - 1;
    let lines = text.split_inclusive('\n').skip(start);
    match limit {
        Some(n) => lines.take(n as usize).collect(),
        None => lines.collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lf-acp-fs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("project/src")).unwrap();
        std::fs::write(d.join("project/src/a.ts"), "a").unwrap();
        std::fs::write(d.join("secret.txt"), "s").unwrap();
        d
    }

    #[test]
    fn paths_inside_the_session_folder() {
        let d = temp("inside");
        let roots = [d.join("project")];
        assert!(is_inside(&d.join("project/src/a.ts"), &roots));
        assert!(is_inside(&d.join("project/./src/../src/a.ts"), &roots));
        assert!(
            is_inside(&d.join("project/new/dir/file.ts"), &roots),
            "files not created yet"
        );
        assert!(is_inside(&d.join("project"), &roots));
        assert!(!is_inside(&d.join("secret.txt"), &roots));
        assert!(
            !is_inside(&d.join("project/../secret.txt"), &roots),
            "`..` escapes"
        );
        assert!(!is_inside(&d.join("project/src/../../secret.txt"), &roots));
        assert!(
            !is_inside(&d.join("project-other/x"), &roots),
            "a sibling with the same prefix"
        );
        assert!(!is_inside(Path::new("/etc/passwd"), &roots));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_pointing_outside_do_not_count() {
        let d = temp("links");
        let roots = [d.join("project")];
        std::os::unix::fs::symlink(d.join("secret.txt"), d.join("project/link.txt")).unwrap();
        std::os::unix::fs::symlink(&d, d.join("project/up")).unwrap();
        assert!(!is_inside(&d.join("project/link.txt"), &roots));
        assert!(!is_inside(&d.join("project/up/secret.txt"), &roots));
        assert!(
            !is_inside(&d.join("project/up/new.txt"), &roots),
            "new file behind a link"
        );
        // A link inside the project to inside the project is fine.
        std::os::unix::fs::symlink(d.join("project/src"), d.join("project/s")).unwrap();
        assert!(is_inside(&d.join("project/s/a.ts"), &roots));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn agent_paths_map_to_this_machine() {
        let wsl = FsKind::Wsl("Ubuntu".into());
        assert_eq!(
            to_local(&wsl, "/home/me/app/a.ts").unwrap(),
            PathBuf::from(r"\\wsl.localhost\Ubuntu\home\me\app\a.ts")
        );
        assert_eq!(
            to_local(&wsl, "/mnt/c/src/app").unwrap(),
            PathBuf::from(r"C:\src\app")
        );
        assert_eq!(
            to_local(&wsl, "/mnt/wsl/x").unwrap(),
            PathBuf::from(r"\\wsl.localhost\Ubuntu\mnt\wsl\x"),
            "only single letters are drives"
        );
        assert!(to_local(&wsl, "relative/a.ts").is_err());
        assert!(to_local(&FsKind::Local, "relative/a.ts").is_err());
        let abs = if cfg!(windows) {
            r"C:\src\a.ts"
        } else {
            "/src/a.ts"
        };
        assert_eq!(to_local(&FsKind::Local, abs).unwrap(), PathBuf::from(abs));
    }

    #[test]
    fn line_ranges() {
        let text = "a\nb\nc\nd";
        assert_eq!(slice_lines(text, None, None), text);
        assert_eq!(slice_lines(text, Some(2), Some(2)), "b\nc\n");
        assert_eq!(slice_lines(text, Some(3), None), "c\nd");
        assert_eq!(slice_lines(text, None, Some(1)), "a\n");
        assert_eq!(
            slice_lines(text, Some(0), Some(1)),
            "a\n",
            "line numbers start at 1"
        );
        assert_eq!(slice_lines(text, Some(9), None), "");
    }
}
