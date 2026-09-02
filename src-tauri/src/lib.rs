mod common;
mod local;
mod mobile;
mod s3;
mod update;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod ai_cli;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod codex_mcp;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod credentials;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod skills;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::Manager;

#[tauri::command]
fn load_mobile_workspace(app: tauri::AppHandle) -> Result<common::WorkspaceSnapshot, String> {
    mobile::load_mobile_workspace(&app)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn set_desktop_window_icon(app: &tauri::App) {
    if let Some(icon) = app.default_window_icon().cloned() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_icon(icon);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|_app| {
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            set_desktop_window_icon(_app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            update::download_update_file,
            load_mobile_workspace,
            s3::load_s3_providers,
            s3::save_s3_providers,
            s3::upsert_s3_provider,
            s3::remove_s3_provider_config,
            s3::save_s3_credentials,
            s3::remove_s3_credentials,
            s3::test_s3_connection,
            s3::list_s3_page_index,
            s3::load_s3_pages,
            s3::load_s3_pages_by_ids,
            s3::save_s3_page,
            s3::permanently_delete_s3_pages,
            s3::list_s3_page_revisions,
            s3::read_s3_page_revision,
            s3::copy_s3_history_to_s3,
            s3::copy_s3_assets_to_s3,
            s3::list_s3_page_assets,
            s3::save_s3_page_asset,
            s3::read_s3_page_asset,
            local::commands::load_workspace,
            local::commands::save_page,
            local::commands::add_storage_source,
            local::commands::remove_storage_source,
            local::commands::rename_storage_source,
            local::commands::rename_workspace,
            local::commands::list_file_page_assets,
            local::commands::save_file_page_asset,
            local::commands::read_file_page_asset,
            local::commands::list_page_revisions,
            local::commands::read_page_revision,
            local::commands::restore_page_revision,
            local::commands::export_page_markdown,
            local::commands::permanently_delete_pages,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            desktop::transfer_page_storage,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            desktop::import_markdown_files,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            desktop::open_markdown_files,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            desktop::copy_page_sidecars,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            desktop::copy_file_history_to_s3,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            desktop::copy_s3_history_to_file,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            desktop::copy_file_assets_to_s3,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            desktop::copy_s3_assets_to_file,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            desktop::export_page_markdown_bundle,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            ai_cli::ai_cli_status,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            ai_cli::ai_cli_suggest_tags,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            codex_mcp::agent_mcp_status,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            codex_mcp::configure_agent_mcp,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            codex_mcp::codex_mcp_status,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            codex_mcp::configure_codex_mcp,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            skills::list_skill_connections,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            skills::list_skill_scan_roots,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            skills::list_extra_skill_scan_roots,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            skills::add_skill_scan_root,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            skills::remove_skill_scan_root,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            skills::scan_skills,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            skills::connect_skill,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            skills::disconnect_skill,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            skills::read_skill_file,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            skills::write_skill_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tie app");
}
