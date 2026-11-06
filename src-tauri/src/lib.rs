//! Leverframe backend. Modules follow docs/PLAN.md (section 3); some are filled in by later stages.

pub mod agents;
pub mod fs;
pub mod profiles;
pub mod pty;
pub mod sessions;
pub mod settings;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(pty::PtyManager::new())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(profiles::ProfileService::new(&config_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::app_info,
            pty::commands::pty_spawn,
            pty::commands::pty_write,
            pty::commands::pty_resize,
            pty::commands::pty_kill,
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
