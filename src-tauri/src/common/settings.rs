use std::path::PathBuf;
use tauri::Manager;
use tie_storage::local::settings as local_settings;
use tie_storage::{StorageSource, WorkspaceSettings};

pub(crate) fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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
