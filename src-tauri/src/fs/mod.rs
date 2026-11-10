//! FsService: files for the editor – directory listing honouring `.gitignore`, reading and writing
//! text files with conflict detection, and the file list for quick open (Ctrl+P).

pub mod commands;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use ignore::WalkBuilder;
use serde::Serialize;

/// Files larger than this are not opened in the editor.
pub const MAX_EDIT_BYTES: u64 = 10 * 1024 * 1024;
/// Upper bound of the quick-open list (very large trees are cut off).
pub const MAX_LIST_FILES: usize = 50_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path: String,
    pub content: String,
    /// Modification time (ms) when read – sent back on save to detect external changes.
    pub mtime: i64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    /// Paths relative to the root, with `/` separators.
    pub files: Vec<String>,
    pub truncated: bool,
}

/// Error kinds the UI reacts to (e.g. offers "overwrite" on a conflict).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FsError {
    Conflict { message: String, mtime: i64 },
    Other { message: String },
}

impl FsError {
    fn other(message: impl Into<String>) -> Self {
        FsError::Other {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for FsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FsError::Conflict { message, .. } | FsError::Other { message } => f.write_str(message),
        }
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn walker(dir: &Path) -> WalkBuilder {
    let mut w = WalkBuilder::new(dir);
    w.hidden(false) // dotfiles such as .env.example or .github are useful in an editor
        .parents(true) // .gitignore files of parent directories apply too
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git");
    w
}

/// One level of a directory: folders first, then files, alphabetically; ignored entries left out.
pub fn list_dir(dir: &Path) -> Result<Vec<DirEntry>, FsError> {
    if !dir.is_dir() {
        return Err(FsError::other(format!(
            "Folder {} nie istnieje",
            dir.display()
        )));
    }
    let mut entries: Vec<DirEntry> = walker(dir)
        .max_depth(Some(1))
        .build()
        .flatten()
        .filter(|e| e.depth() == 1)
        .map(|e| DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path().to_string_lossy().into_owned(),
            is_dir: e.file_type().is_some_and(|t| t.is_dir()),
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// All files under `root` (honouring ignore files) for quick open.
pub fn list_files(root: &Path, limit: usize) -> Result<FileList, FsError> {
    if !root.is_dir() {
        return Err(FsError::other(format!(
            "Folder {} nie istnieje",
            root.display()
        )));
    }
    let mut files = Vec::new();
    let mut truncated = false;
    for entry in walker(root).build().flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if files.len() >= limit {
            truncated = true;
            break;
        }
        if let Ok(rel) = entry.path().strip_prefix(root) {
            files.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    files.sort();
    Ok(FileList { files, truncated })
}

/// Largest image shown in the Markdown preview.
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// Image formats the Markdown preview shows, with their MIME types.
const IMAGE_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
    ("bmp", "image/bmp"),
    ("ico", "image/x-icon"),
    ("avif", "image/avif"),
];

/// MIME type of an image file by extension; `None` for anything else.
pub fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_TYPES.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m)
}

/// Reads an image for the Markdown preview: only image extensions, up to `MAX_IMAGE_BYTES`.
pub fn read_image(path: &Path) -> Result<Vec<u8>, FsError> {
    if image_mime(path).is_none() {
        return Err(FsError::other("To nie jest obraz"));
    }
    let meta = std::fs::metadata(path)
        .map_err(|e| FsError::other(format!("Nie można otworzyć obrazu: {e}")))?;
    if !meta.is_file() || meta.len() > MAX_IMAGE_BYTES {
        return Err(FsError::other("Obraz jest za duży albo nie jest plikiem"));
    }
    std::fs::read(path).map_err(|e| FsError::other(format!("Nie można odczytać obrazu: {e}")))
}

pub fn read_text(path: &Path) -> Result<TextFile, FsError> {
    let meta = std::fs::metadata(path)
        .map_err(|e| FsError::other(format!("Nie można otworzyć pliku: {e}")))?;
    if meta.is_dir() {
        return Err(FsError::other("To jest folder"));
    }
    if meta.len() > MAX_EDIT_BYTES {
        return Err(FsError::other(format!(
            "Plik jest za duży do edycji ({} MB, limit {} MB)",
            meta.len() / 1024 / 1024,
            MAX_EDIT_BYTES / 1024 / 1024
        )));
    }
    let bytes = std::fs::read(path)
        .map_err(|e| FsError::other(format!("Nie można odczytać pliku: {e}")))?;
    if bytes.iter().take(8 * 1024).any(|&b| b == 0) {
        return Err(FsError::other(
            "To plik binarny – edytor obsługuje tylko pliki tekstowe",
        ));
    }
    let content =
        String::from_utf8(bytes).map_err(|_| FsError::other("Plik nie jest zapisany w UTF-8"))?;
    Ok(TextFile {
        path: path.to_string_lossy().into_owned(),
        content,
        mtime: mtime_ms(&meta),
        size: meta.len(),
    })
}

/// Writes `content`. When `expected_mtime` is given and the file changed on disk since it was read,
/// nothing is written and `Conflict` is returned. The file is written in place, so its permissions
/// (e.g. the executable bit of scripts) are kept. Returns the new modification time.
pub fn write_text(path: &Path, content: &str, expected_mtime: Option<i64>) -> Result<i64, FsError> {
    if let (Some(expected), Ok(meta)) = (expected_mtime, std::fs::metadata(path)) {
        let current = mtime_ms(&meta);
        if current != expected {
            return Err(FsError::Conflict {
                message: "Plik został zmieniony na dysku po otwarciu".into(),
                mtime: current,
            });
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|e| FsError::other(format!("Nie można zapisać pliku: {e}")))?;
    file.write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| FsError::other(format!("Nie można zapisać pliku: {e}")))?;
    drop(file);
    let meta = std::fs::metadata(path).map_err(|e| FsError::other(e.to_string()))?;
    Ok(mtime_ms(&meta))
}

/// Absolute path of `rel` inside `root` (used by quick open).
pub fn join(root: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(root.to_path_buf(), |p, part| p.join(part))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lf-fs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn reads_only_images_for_the_preview() {
        let d = temp("image");
        let png = d.join("Logo.PNG");
        std::fs::write(&png, [0x89, b'P', b'N', b'G', 0]).unwrap();
        std::fs::write(d.join("secret.txt"), "token").unwrap();
        std::fs::create_dir_all(d.join("dir.png")).unwrap();
        assert_eq!(image_mime(&png), Some("image/png"));
        assert_eq!(image_mime(&d.join("a.svg")), Some("image/svg+xml"));
        assert_eq!(read_image(&png).unwrap(), vec![0x89, b'P', b'N', b'G', 0]);
        assert!(
            read_image(&d.join("secret.txt")).is_err(),
            "only image extensions"
        );
        assert!(
            read_image(&d.join("dir.png")).is_err(),
            "folders are not images"
        );
        assert!(read_image(&d.join("missing.png")).is_err());
        std::fs::remove_dir_all(d).unwrap();
    }

    fn tree(root: &Path) {
        for dir in [
            "src/nested",
            "node_modules/pkg",
            ".git/objects",
            "target",
            ".github",
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        let files = [
            (".gitignore", "node_modules/\ntarget\n*.log\n"),
            ("README.md", "# demo"),
            ("Zeta.txt", "z"),
            ("app.log", "noise"),
            ("src/main.rs", "fn main() {}"),
            ("src/nested/.gitignore", "secret.txt\n"),
            ("src/nested/secret.txt", "s"),
            ("src/nested/ok.rs", "ok"),
            ("node_modules/pkg/index.js", "x"),
            ("target/out.bin", "x"),
            (".git/HEAD", "ref"),
            (".github/ci.yml", "on: push"),
        ];
        for (p, c) in files {
            std::fs::write(root.join(p), c).unwrap();
        }
    }

    #[test]
    fn lists_one_level_folders_first_without_ignored_entries() {
        let root = temp("list");
        tree(&root);
        let names: Vec<_> = list_dir(&root)
            .unwrap()
            .into_iter()
            .map(|e| (e.name, e.is_dir))
            .collect();
        assert_eq!(
            names,
            [
                (".github".to_string(), true),
                ("src".to_string(), true),
                (".gitignore".to_string(), false),
                ("README.md".to_string(), false),
                ("Zeta.txt".to_string(), false),
            ],
            ".git, node_modules, target and *.log are hidden"
        );
        let nested: Vec<_> = list_dir(&root.join("src/nested"))
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(nested, [".gitignore", "ok.rs"], "nested .gitignore applies");
        assert!(list_dir(&root.join("missing")).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn lists_all_files_for_quick_open() {
        let root = temp("files");
        tree(&root);
        let list = list_files(&root, 1000).unwrap();
        assert_eq!(
            list.files,
            [
                ".github/ci.yml",
                ".gitignore",
                "README.md",
                "Zeta.txt",
                "src/main.rs",
                "src/nested/.gitignore",
                "src/nested/ok.rs"
            ]
        );
        assert!(!list.truncated);
        let cut = list_files(&root, 3).unwrap();
        assert_eq!(cut.files.len(), 3);
        assert!(cut.truncated);
        assert_eq!(
            join(&root, "src/nested/ok.rs"),
            root.join("src").join("nested").join("ok.rs")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reads_and_writes_text_with_conflict_detection() {
        let root = temp("rw");
        let file = root.join("a.txt");
        std::fs::write(&file, "zażółć\r\nline").unwrap();
        let f = read_text(&file).unwrap();
        assert_eq!(f.content, "zażółć\r\nline", "line endings preserved");

        let new_mtime = write_text(&file, "changed", Some(f.mtime)).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "changed");

        // Someone else changes the file; saving with the old mtime is refused.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&file, "external edit").unwrap();
        let err = write_text(&file, "mine", Some(new_mtime)).unwrap_err();
        assert!(matches!(err, FsError::Conflict { .. }), "{err:?}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "external edit");
        // Overwrite on purpose (no expected mtime).
        write_text(&file, "mine", None).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_permissions_when_saving() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp("perm");
        let file = root.join("run.sh");
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        write_text(&file, "#!/bin/sh\necho hi\n", None).unwrap();
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o755
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_binary_large_and_non_utf8_files() {
        let root = temp("bad");
        std::fs::write(root.join("bin"), [0u8, 1, 2, 3]).unwrap();
        std::fs::write(root.join("latin2"), [0x7a, 0xb1, 0x0a]).unwrap();
        assert!(read_text(&root.join("bin"))
            .unwrap_err()
            .to_string()
            .contains("binarny"));
        assert!(read_text(&root.join("latin2"))
            .unwrap_err()
            .to_string()
            .contains("UTF-8"));
        assert!(read_text(&root).is_err());
        let big = std::fs::File::create(root.join("big")).unwrap();
        big.set_len(MAX_EDIT_BYTES + 1).unwrap();
        assert!(read_text(&root.join("big"))
            .unwrap_err()
            .to_string()
            .contains("za duży"));
        let _ = std::fs::remove_dir_all(root);
    }
}
