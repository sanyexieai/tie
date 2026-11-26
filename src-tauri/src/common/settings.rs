use std::path::PathBuf;
use tauri::Manager;
use tie_storage::local::settings as local_settings;
use tie_storage::{StorageSource, WorkspaceSettings};

pub(crate) fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(directory) = std::env::var_os("TIE_APP_DATA").filter(|value| !value.is_empty()) {
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        return Ok(PathBuf::from(directory));
    }
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

pub(crate) fn load_settings(app: &tauri::AppHandle) -> Result<WorkspaceSettings, String> {
    local_settings::load(&app_data_dir(app)?)
}

pub(crate) fn save_settings(
    app: &tauri::AppHandle,
    settings: &WorkspaceSettings,
) -> Result<(), String> {
    local_settings::save(&app_data_dir(app)?, settings)
}

pub(crate) fn workspace_sources(
    app: &tauri::AppHandle,
) -> Result<(Vec<StorageSource>, bool), String> {
    let data_dir = app_data_dir(app)?;
    let settings = local_settings::load(&data_dir)?;
    Ok(local_settings::workspace_sources(
        &settings,
        &tie_storage::local::default_workspace_root(&data_dir),
    ))
}

pub(crate) fn load_workspace_snapshot(app: &tauri::AppHandle) -> Result<tie_storage::WorkspaceSnapshot, String> {
    let snapshot = tie_storage::local::load_file_workspace(&app_data_dir(app)?, "tie-workspace")?;
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let mut snapshot = snapshot;
        crate::desktop::temporary::append_snapshot(app, &mut snapshot)?;
        Ok(snapshot)
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    { Ok(snapshot) }
}

#[tauri::command]
pub(crate) fn get_device_identity(app: tauri::AppHandle) -> Result<tie_storage::identity::DeviceIdentity, String> {
    tie_storage::identity::load_or_create_device_identity_at(&app_data_dir(&app)?)
}

pub(crate) fn app_change_origin(app: &tauri::AppHandle) -> Result<tie_storage::identity::ChangeOrigin, String> {
    let device = tie_storage::identity::load_or_create_device_identity_at(&app_data_dir(app)?)?;
    let (client_id, client_name) = if cfg!(target_os = "android") { ("tie-android", "Tie Android") } else if cfg!(target_os = "ios") { ("tie-ios", "Tie iOS") } else { ("tie-desktop", "Tie") };
    Ok(tie_storage::identity::ChangeOrigin { client_id: client_id.into(), client_name: client_name.into(), client_version: app.package_info().version.to_string(),
        device_id: device.id, device_name: device.name, platform: device.platform, actor: client_name.into(), user_id: None })
}

#[tauri::command]
pub(crate) fn get_change_origin(app: tauri::AppHandle) -> Result<tie_storage::identity::ChangeOrigin, String> { app_change_origin(&app) }
