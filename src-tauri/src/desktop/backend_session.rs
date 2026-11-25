use crate::common::app_data_dir;
use tauri::AppHandle;
use tie_storage::local::backend_session::{self, BackendSession};

#[tauri::command]
pub(crate) async fn load_backend_session() -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(tie_cli::backend_sync::load_session_for_ui)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn refresh_backend_session(force: Option<bool>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tie_cli::backend_sync::refresh_session_for_ui(force.unwrap_or(false))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn save_backend_session(
    app: AppHandle,
    endpoint: String,
    access_token: String,
    refresh_token: Option<String>,
    access_expires_at: Option<String>,
    user_id: String,
    email: String,
    name: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn clear_backend_session(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        backend_session::clear_session_at(&app_data_dir(&app)?)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::Duration};

    #[test]
    fn waiting_for_the_session_lock_keeps_the_async_executor_responsive() {
        let dir = std::env::temp_dir().join(format!("tie-session-ui-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("backend-session.lock"), b"").unwrap();
        let previous = std::env::var_os("TIE_APP_DATA");
        std::env::set_var("TIE_APP_DATA", &dir);
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (responsive, result) = runtime.block_on(async {
            let session = tokio::spawn(load_backend_session());
            tokio::time::sleep(Duration::from_millis(50)).await;
            let responsive = !session.is_finished();
            (responsive, session.await)
        });
        if let Some(value) = previous {
            std::env::set_var("TIE_APP_DATA", value);
        } else {
            std::env::remove_var("TIE_APP_DATA");
        }
        fs::remove_dir_all(dir).unwrap();
        assert!(responsive, "the session lock blocked the async executor");
        assert!(result.unwrap().unwrap().is_none());
    }
}
