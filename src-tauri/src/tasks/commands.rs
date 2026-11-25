//! Commands of the task list (#105). Tasks are named by scope and file name.

use std::path::PathBuf;

use tauri::State;

use super::{Scope, Task, TaskChange, TaskDirs};
use crate::settings::SettingsStore;

/// The global tasks' folder (`<app data>/tasks`), managed at start.
pub struct GlobalTasksDir(pub PathBuf);

fn dirs(settings: &SettingsStore, global: &GlobalTasksDir) -> TaskDirs {
    TaskDirs {
        project: crate::settings::project_dir(settings).map(PathBuf::from),
        global: global.0.clone(),
    }
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// The tasks of a scope, by number.
#[tauri::command]
pub async fn tasks_list(
    settings: State<'_, SettingsStore>,
    global: State<'_, GlobalTasksDir>,
    scope: Scope,
) -> Result<Vec<Task>, String> {
    let dir = dirs(&settings, &global).dir(scope)?;
    blocking(move || super::list(&dir, scope)).await
}

/// The folder of a scope's tasks (it may not exist yet).
#[tauri::command]
pub fn tasks_dir(
    settings: State<'_, SettingsStore>,
    global: State<'_, GlobalTasksDir>,
    scope: Scope,
) -> Result<String, String> {
    Ok(dirs(&settings, &global)
        .dir(scope)?
        .to_string_lossy()
        .into_owned())
}

/// A new task with `title`. In the project, `.leverframe/` is first kept out of its repository.
#[tauri::command]
pub async fn tasks_create(
    settings: State<'_, SettingsStore>,
    global: State<'_, GlobalTasksDir>,
    scope: Scope,
    title: String,
) -> Result<Task, String> {
    let dirs = dirs(&settings, &global);
    let dir = dirs.dir(scope)?;
    blocking(move || {
        if let (Scope::Project, Some(project)) = (scope, &dirs.project) {
            super::exclude_from_git(project)?;
        }
        super::create(&dir, scope, &title)
    })
    .await
}

/// Changes a task's title or status.
#[tauri::command]
pub async fn tasks_update(
    settings: State<'_, SettingsStore>,
    global: State<'_, GlobalTasksDir>,
    scope: Scope,
    file: String,
    change: TaskChange,
) -> Result<Task, String> {
    let dir = dirs(&settings, &global).dir(scope)?;
    blocking(move || super::update(&dir, scope, &file, &change)).await
}

/// Moves a task between the project and the global tasks.
#[tauri::command]
pub async fn tasks_move(
    settings: State<'_, SettingsStore>,
    global: State<'_, GlobalTasksDir>,
    scope: Scope,
    file: String,
    to: Scope,
) -> Result<Task, String> {
    let dirs = dirs(&settings, &global);
    let from_dir = dirs.dir(scope)?;
    let to_dir = dirs.dir(to)?;
    blocking(move || {
        if let (Scope::Project, Some(project)) = (to, &dirs.project) {
            super::exclude_from_git(project)?;
        }
        super::move_task(&from_dir, scope, &file, &to_dir, to)
    })
    .await
}

/// Deletes a task: to the system trash, or `permanently`.
#[tauri::command]
pub async fn tasks_delete(
    settings: State<'_, SettingsStore>,
    global: State<'_, GlobalTasksDir>,
    scope: Scope,
    file: String,
    permanently: bool,
) -> Result<(), String> {
    let dir = dirs(&settings, &global).dir(scope)?;
    blocking(move || super::delete(&dir, &file, permanently)).await
}
