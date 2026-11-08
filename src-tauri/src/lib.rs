//! Leverframe backend. Modules follow docs/PLAN.md (section 3); some are filled in by later stages.

pub mod agents;
pub mod fs;
pub mod profiles;
pub mod pty;
pub mod sessions;
pub mod settings;

use tauri::{Emitter, Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyManager::new())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(profiles::ProfileService::new(&config_dir));
            app.manage(agents::AgentService::new(&config_dir));
            app.manage(settings::SettingsStore::new(&config_dir));
            let data_dir = app.path().app_data_dir()?;
            app.manage(sessions::SessionService::open(&data_dir, &config_dir)?);
            let logs = std::sync::Arc::new(sessions::logs::AgentLogService::new());
            let handle = app.handle().clone();
            let watcher = sessions::logs::watch(
                logs.local_roots(),
                std::time::Duration::from_millis(500),
                move || {
                    let _ = handle.emit("agent-logs-changed", ());
                },
            );
            app.manage(watcher);
            app.manage(logs);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::app_info,
            settings::settings_project_dir,
            settings::settings_set_project_dir,
            settings::settings_read,
            settings::settings_update,
            settings::settings_ensure_file,
            pty::commands::pty_spawn,
            pty::commands::pty_write,
            pty::commands::pty_resize,
            pty::commands::pty_kill,
            pty::commands::pty_list,
            agents::commands::agents_list,
            agents::commands::agents_detect,
            sessions::commands::sessions_info,
            sessions::commands::sessions_list,
            sessions::commands::sessions_facets,
            sessions::commands::sessions_read,
            sessions::commands::sessions_delete,
            sessions::commands::sessions_clear,
            sessions::commands::sessions_set_recording,
            sessions::logs::commands::agent_logs_list,
            sessions::logs::commands::agent_log_read,
            fs::commands::fs_list_dir,
            fs::commands::fs_list_files,
            fs::commands::fs_read_text,
            fs::commands::fs_write_text,
            profiles::commands::profiles_list,
            profiles::commands::profiles_refresh,
            profiles::commands::profile_save,
            profiles::commands::profile_delete,
            profiles::commands::profile_set_default,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Leverframe")
        .run(|app, event| {
            // Do not leave shells (and the programs they run) behind when the app closes.
            if let RunEvent::Exit = event {
                app.state::<pty::PtyManager>().kill_all();
            }
        });
}
