//! Leverframe backend. Modules follow docs/PLAN.md (section 3); some are filled in by later stages.

pub mod acp;
pub mod agents;
pub mod docker;
pub mod fs;
pub mod profiles;
pub mod pty;
pub mod sessions;
pub mod settings;
#[cfg(test)]
mod test_support;

use tauri::{Emitter, Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyManager::new())
        .manage(acp::AcpService::default())
        .manage(docker::DockerJobs::default())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(profiles::ProfileService::new(&config_dir));
            app.manage(agents::AgentService::new(&config_dir));
            let settings_store = settings::SettingsStore::new(&config_dir);
            // The system's window frame instead of Leverframe's title bar (setting windowFrame;
            // by default on Windows).
            let frame = settings_store.get_string(settings::WINDOW_FRAME_KEY);
            if settings::system_frame(frame.as_deref(), cfg!(windows)) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(true);
                }
            }
            app.manage(settings_store);
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
            settings::settings_recent_project_dirs,
            settings::settings_remote_dirs,
            settings::settings_set_remote_dir,
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
            agents::commands::agents_save_settings,
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
            fs::commands::fs_read_image,
            fs::commands::fs_write_text,
            fs::commands::fs_create,
            fs::commands::fs_delete,
            profiles::commands::profiles_list,
            profiles::commands::profiles_refresh,
            profiles::commands::profile_save,
            profiles::commands::profile_delete,
            profiles::commands::profile_set_default,
            acp::commands::acp_start,
            acp::commands::acp_prompt,
            acp::commands::acp_cancel,
            acp::commands::acp_permission_reply,
            acp::commands::acp_fs_reply,
            acp::commands::acp_terminal_reply,
            acp::commands::acp_authenticate,
            acp::commands::acp_set_mode,
            acp::commands::acp_set_config_option,
            acp::commands::acp_stop,
            docker::commands::docker_info,
            docker::commands::docker_images,
            docker::commands::docker_containers,
            docker::commands::docker_volumes,
            docker::commands::docker_inspect,
            docker::commands::docker_create_plan,
            docker::commands::docker_create,
            docker::commands::docker_container_action,
            docker::commands::docker_remove_container,
            docker::commands::docker_remove_image,
            docker::commands::docker_remove_volume,
            docker::commands::docker_prune_images,
            docker::commands::docker_pull,
            docker::commands::docker_build,
            docker::commands::docker_sources,
            docker::commands::docker_set_source,
            docker::commands::docker_set_ssh_mode,
            docker::commands::docker_agents_image,
            docker::commands::docker_build_agents_image,
            docker::commands::docker_logs,
            docker::commands::docker_cancel,
            docker::commands::docker_prepare_container,
            acp::commands::acp_list_sessions,
            acp::commands::acp_load_session,
            acp::commands::acp_delete_session,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Leverframe")
        .run(|app, event| {
            // Do not leave shells (and the programs they run) behind when the app closes.
            if let RunEvent::Exit = event {
                app.state::<pty::PtyManager>().kill_all();
                app.state::<acp::AcpService>().stop_all();
                app.state::<docker::DockerJobs>().cancel_all();
            }
        });
}
