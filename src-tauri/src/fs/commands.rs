//! The editor is a local app: these commands work on any path the user can open
//! (like VS Code). Only the app's own UI can call them (no remote content is loaded).

use std::path::PathBuf;

use super::{
    list_dir, list_files, read_text, write_text, DirEntry, FileList, FsError, TextFile,
    MAX_LIST_FILES,
};

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, FsError> + Send + 'static,
) -> Result<T, FsError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| FsError::Other {
            message: e.to_string(),
        })?
}

#[tauri::command]
pub async fn fs_list_dir(path: String) -> Result<Vec<DirEntry>, FsError> {
    blocking(move || list_dir(&PathBuf::from(path))).await
}

#[tauri::command]
pub async fn fs_list_files(root: String) -> Result<FileList, FsError> {
    blocking(move || list_files(&PathBuf::from(root), MAX_LIST_FILES)).await
}

#[tauri::command]
pub async fn fs_read_text(path: String) -> Result<TextFile, FsError> {
    blocking(move || read_text(&PathBuf::from(path))).await
}

#[tauri::command]
pub async fn fs_write_text(
    path: String,
    content: String,
    expected_mtime: Option<i64>,
) -> Result<i64, FsError> {
    blocking(move || write_text(&PathBuf::from(path), &content, expected_mtime)).await
}
