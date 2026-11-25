//! Logged-in backend user. The token stays in the app data directory, never in a workspace.

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

const FILE_NAME: &str = "backend-session.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendSession {
    pub endpoint: String,
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub access_expires_at: String,
    pub user_id: String,
    pub email: String,
    pub name: String,
}

pub fn app_data_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("TIE_APP_DATA") {
        let path = PathBuf::from(dir.trim());
        if !path.as_os_str().is_empty() {
            fs::create_dir_all(&path).map_err(|error| error.to_string())?;
            return Ok(path);
        }
    }
    #[cfg(windows)]
    {
        let appdata = std::env::var("APPDATA").map_err(|_| "找不到应用数据目录".to_owned())?;
        return Ok(PathBuf::from(appdata).join("com.tie.knowledge"));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").map_err(|_| "找不到应用数据目录".to_owned())?;
        return Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("com.tie.knowledge"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .map(|home| PathBuf::from(home).join(".local").join("share"))
            })
            .ok_or_else(|| "找不到应用数据目录".to_owned())?;
        Ok(base.join("com.tie.knowledge"))
    }
}

pub fn write_session_at(dir: &std::path::Path, session: &BackendSession) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let body = serde_json::to_string_pretty(session).map_err(|error| error.to_string())?;
    fs::write(dir.join(FILE_NAME), format!("{body}\n")).map_err(|error| error.to_string())
}

pub fn read_session_at(dir: &std::path::Path) -> Result<Option<BackendSession>, String> {
    let path = dir.join(FILE_NAME);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let session = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    Ok(Some(session))
}

pub fn clear_session_at(dir: &std::path::Path) -> Result<(), String> {
    let path = dir.join(FILE_NAME);
    if path.is_file() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn write_session(session: &BackendSession) -> Result<(), String> {
    write_session_at(&app_data_dir()?, session)
}

pub fn read_session() -> Result<Option<BackendSession>, String> {
    read_session_at(&app_data_dir()?)
}

pub fn clear_session() -> Result<(), String> {
    clear_session_at(&app_data_dir()?)
}
