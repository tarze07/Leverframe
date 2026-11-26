//! Commands of the task list (#105). Tasks are named by scope and file name.

use std::path::PathBuf;

use tauri::State;

use super::{Scope, Task, TaskChange, TaskDirs};
use crate::settings::SettingsStore;

/// The global tasks' folder (`<app data>/tasks`), managed at start.
pub struct GlobalTasksDir(pub PathBuf);

/// The folders of the tasks from the settings (#114).
fn dirs(settings: &SettingsStore, global: &GlobalTasksDir) -> TaskDirs {
    let rel = super::project_tasks_dir(settings.get_string(super::PROJECT_DIR_KEY).as_deref())
        .unwrap_or_else(|_| super::PROJECT_TASKS_DIR.into());
    let custom = settings
        .get_string(super::GLOBAL_DIR_KEY)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && std::path::Path::new(s).is_absolute());
    TaskDirs {
        project: crate::settings::project_dir(settings).map(PathBuf::from),
        project_rel: rel,
        global: custom
            .map(PathBuf::from)
            .unwrap_or_else(|| global.0.clone()),
    }
}

/// The project's tasks folder stays out of git (setting, by default yes).
fn exclude(settings: &SettingsStore) -> bool {
    settings.get_value(super::EXCLUDE_KEY) != Some(serde_json::Value::Bool(false))
}

/// Keeps the project's tasks folder out of its repository (`exclude`: the setting).
fn keep_out_of_git(exclude: bool, dirs: &TaskDirs) -> Result<(), String> {
    if let (true, Some(project)) = (exclude, &dirs.project) {
        super::exclude_from_git(project, &dirs.project_rel)?;
    }
    Ok(())
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

/// A new task with `title`. In the project, its folder is first kept out of its repository.
#[tauri::command]
pub async fn tasks_create(
    settings: State<'_, SettingsStore>,
    global: State<'_, GlobalTasksDir>,
    scope: Scope,
    title: String,
) -> Result<Task, String> {
    let dirs = dirs(&settings, &global);
    let dir = dirs.dir(scope)?;
    let ex = exclude(&settings) && scope == Scope::Project;
    blocking(move || {
        keep_out_of_git(ex, &dirs)?;
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
    let ex = exclude(&settings) && to == Scope::Project;
    blocking(move || {
        keep_out_of_git(ex, &dirs)?;
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

/// Notes a start of an agent on a task (and sets it to „W toku”).
#[tauri::command]
pub async fn tasks_add_run(
    settings: State<'_, SettingsStore>,
    global: State<'_, GlobalTasksDir>,
    scope: Scope,
    file: String,
    run: super::TaskRun,
) -> Result<Task, String> {
    let dir = dirs(&settings, &global).dir(scope)?;
    blocking(move || super::add_run(&dir, scope, &file, &run)).await
}

fn profile(
    profiles: &crate::profiles::ProfileService,
    id: &str,
) -> Result<crate::profiles::Profile, String> {
    profiles
        .resolve(id)
        .ok_or_else(|| format!("Profil „{id}” nie istnieje"))
}

/// Copies a task to the computer of an SSH or container profile, into the project's tasks
/// folder under `dir` (`<dir>/.leverframe/tasks/` by default; #108, #114); its path there.
#[tauri::command]
pub async fn tasks_copy_to(
    settings: State<'_, SettingsStore>,
    global: State<'_, GlobalTasksDir>,
    profiles: State<'_, crate::profiles::ProfileService>,
    scope: Scope,
    file: String,
    profile_id: String,
    dir: String,
) -> Result<String, String> {
    let dirs = dirs(&settings, &global);
    let tasks = dirs.dir(scope)?;
    let ex = exclude(&settings);
    let profile = profile(&profiles, &profile_id)?;
    blocking(move || {
        let path = super::task_path(&tasks, &file)?;
        let text = super::read(&path)?;
        crate::fs::remote::put_task(&profile, &dir, &dirs.project_rel, &file, &text, ex)
    })
    .await
}

/// The text of a task's copy on that computer ("Pobierz wynik").
#[tauri::command]
pub async fn tasks_read_remote(
    profiles: State<'_, crate::profiles::ProfileService>,
    profile_id: String,
    path: String,
) -> Result<String, String> {
    let profile = profile(&profiles, &profile_id)?;
    blocking(move || crate::fs::remote::read_file(&profile, &path)).await
}

/// Moves the tasks of a scope's former folder `from` into its folder now (after the folder was
/// changed in the settings, #114); how many moved.
#[tauri::command]
pub async fn tasks_adopt(
    settings: State<'_, SettingsStore>,
    global: State<'_, GlobalTasksDir>,
    scope: Scope,
    from: String,
) -> Result<usize, String> {
    let dirs = dirs(&settings, &global);
    let to = dirs.dir(scope)?;
    let ex = exclude(&settings) && scope == Scope::Project;
    let from = PathBuf::from(from);
    if !from.is_absolute() {
        return Err("Nieprawidłowy folder zadań".into());
    }
    blocking(move || {
        keep_out_of_git(ex, &dirs)?;
        super::move_all(&from, &to, scope)
    })
    .await
}

/// Opens the folder of a scope's tasks in the system's file manager (made when missing); its path.
#[tauri::command]
pub async fn tasks_open_dir(
    app: tauri::AppHandle,
    settings: State<'_, SettingsStore>,
    global: State<'_, GlobalTasksDir>,
    scope: Scope,
) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = dirs(&settings, &global).dir(scope)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Nie można utworzyć {}: {e}", dir.display()))?;
    let path = dir.to_string_lossy().into_owned();
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| format!("Nie można otworzyć {path}: {e}"))?;
    Ok(path)
}
