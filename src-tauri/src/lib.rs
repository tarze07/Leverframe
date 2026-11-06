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
        .invoke_handler(tauri::generate_handler![
            settings::app_info,
            pty::commands::pty_spawn,
            pty::commands::pty_write,
            pty::commands::pty_resize,
            pty::commands::pty_kill,
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
