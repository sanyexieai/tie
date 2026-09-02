use super::types::*;
use std::{fs, path::PathBuf};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::Path,
};
use tauri::Manager;

pub(crate) fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

pub(crate) fn load_settings(app: &tauri::AppHandle) -> Result<WorkspaceSettings, String> {
    let settings_path = app_data_dir(app)?.join("workspace.json");
    match fs::read_to_string(settings_path) {
        Ok(content) => serde_json::from_str(&content).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(WorkspaceSettings {
            name: String::new(),
            path: String::new(),
            kind: String::new(),
            sources: Vec::new(),
            s3_providers: Vec::new(),
        }),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn save_settings(app: &tauri::AppHandle, settings: &WorkspaceSettings) -> Result<(), String> {
    let content = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(app_data_dir(app)?.join("workspace.json"), content).map_err(|error| error.to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn source_id(path: &Path, kind: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    kind.hash(&mut hasher);
    format!("src_{kind}_{:016x}", hasher.finish())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn source_from_path(path: PathBuf, kind: String) -> StorageSource {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("我的知识库")
        .to_owned();
    StorageSource {
        id: source_id(&path, &kind),
        name,
        kind,
        path: path.display().to_string(),
        available: true,
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn workspace_sources(app: &tauri::AppHandle) -> Result<(Vec<StorageSource>, bool), String> {
    let settings = load_settings(app)?;
    if !settings.sources.is_empty() {
        return Ok((settings.sources, false));
    }
    if !settings.path.is_empty() {
        let kind = if settings.kind == "smb" {
            "smb"
        } else {
            "local"
        }
        .to_owned();
        return Ok((
            vec![source_from_path(PathBuf::from(settings.path), kind)],
            false,
        ));
    }
    let root = app_data_dir(app)?.join("workspace");
    Ok((vec![source_from_path(root, "local".to_owned())], true))
}
