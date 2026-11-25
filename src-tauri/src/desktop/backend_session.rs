use crate::common::app_data_dir;
use tauri::AppHandle;
use tie_storage::local::backend_session::{self, BackendSession};

#[tauri::command]
pub(crate) fn load_backend_session() -> Result<Option<serde_json::Value>, String> {
    tie_cli::backend_sync::load_session_for_ui()
}

#[tauri::command]
pub(crate) fn refresh_backend_session(force: Option<bool>) -> Result<serde_json::Value, String> {
    tie_cli::backend_sync::refresh_session_for_ui(force.unwrap_or(false))
}

#[tauri::command]
pub(crate) fn save_backend_session(
    app: AppHandle,
    endpoint: String,
    access_token: String,
    refresh_token: Option<String>,
    access_expires_at: Option<String>,
    user_id: String,
    email: String,
    name: String,
) -> Result<(), String> {
    let endpoint = endpoint.trim().trim_end_matches('/').to_owned();
    backend_session::write_session_at(
        &app_data_dir(&app)?,
        &BackendSession {
            endpoint,
            access_token,
            refresh_token: refresh_token.unwrap_or_default(),
            access_expires_at: access_expires_at.unwrap_or_default(),
            user_id,
            email,
            name,
        },
    )
}

#[tauri::command]
pub(crate) fn clear_backend_session(app: AppHandle) -> Result<(), String> {
    backend_session::clear_session_at(&app_data_dir(&app)?)
}
