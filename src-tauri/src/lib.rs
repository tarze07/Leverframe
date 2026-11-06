//! Leverframe backend. Modules follow docs/PLAN.md (section 3); most are filled in by later stages.

pub mod agents;
pub mod fs;
pub mod profiles;
pub mod pty;
pub mod sessions;
pub mod settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![settings::app_info])
        .run(tauri::generate_context!())
        .expect("error while running Leverframe");
}
