//! The editor is a local app: these commands work on any path the user can open
//! (like VS Code). Only the app's own UI can call them (no remote content is loaded).

use std::path::PathBuf;

use super::{
    create_entry, delete_entry, list_dir, list_files, read_image, read_text, write_text, DirEntry,
    FileList, FsError, TextFile, MAX_LIST_FILES,
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

/// Image bytes for the Markdown preview (sent raw, no base64 / JSON overhead).
#[tauri::command]
pub async fn fs_read_image(path: String) -> Result<tauri::ipc::Response, FsError> {
    blocking(move || read_image(&PathBuf::from(path)))
        .await
        .map(tauri::ipc::Response::new)
}

/// Creates an empty file or a folder `name` (may contain `/`) in `parent`; returns its path.
#[tauri::command]
pub async fn fs_create(parent: String, name: String, dir: bool) -> Result<String, FsError> {
    blocking(move || {
        create_entry(&PathBuf::from(parent), &name, dir).map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

/// Deletes a file or folder of the project folder: to the system trash, or `permanently`.
#[tauri::command]
pub async fn fs_delete(
    settings: tauri::State<'_, crate::settings::SettingsStore>,
    path: String,
    permanently: bool,
) -> Result<(), FsError> {
    let root = crate::settings::project_dir(&settings).ok_or_else(|| FsError::Other {
        message: "Najpierw otwórz folder projektu".into(),
    })?;
    blocking(move || delete_entry(&PathBuf::from(root), &PathBuf::from(path), permanently)).await
}

/// Folders of `path` on the computer of an SSH, WSL or container profile (`~` and empty: home).
#[tauri::command]
pub async fn remote_list_dirs(
    profiles: tauri::State<'_, crate::profiles::ProfileService>,
    profile_id: String,
    path: String,
    show_hidden: bool,
) -> Result<super::remote::RemoteDirs, String> {
    let profile = profiles
        .resolve(&profile_id)
        .ok_or_else(|| format!("Profil „{profile_id}” nie istnieje"))?;
    tauri::async_runtime::spawn_blocking(move || super::remote::list(&profile, &path, show_hidden))
        .await
        .map_err(|e| e.to_string())?
}

/// Makes the folder `name` in `parent` on that computer; returns the new folder's listing.
#[tauri::command]
pub async fn remote_make_dir(
    profiles: tauri::State<'_, crate::profiles::ProfileService>,
    profile_id: String,
    parent: String,
    name: String,
) -> Result<super::remote::RemoteDirs, String> {
    let profile = profiles
        .resolve(&profile_id)
        .ok_or_else(|| format!("Profil „{profile_id}” nie istnieje"))?;
    tauri::async_runtime::spawn_blocking(move || super::remote::mkdir(&profile, &parent, &name))
        .await
        .map_err(|e| e.to_string())?
}
