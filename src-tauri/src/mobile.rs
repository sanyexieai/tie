use crate::common::{app_data_dir, load_settings, StorageSource, WorkspaceSnapshot};
use tie_storage::local::load_file_workspace;

#[cfg(any(target_os = "android", target_os = "ios"))]
use std::fs;

pub fn load_mobile_workspace(app: &tauri::AppHandle) -> Result<WorkspaceSnapshot, String> {
    let data_dir = app_data_dir(app)?;
    let mut snapshot = load_file_workspace(&data_dir, "tie-mobile")?;
    let settings = load_settings(app)?;
    for provider in &settings.s3_providers {
        let id = format!("s3:{}", provider.id);
        if snapshot.workspace.sources.iter().any(|source| source.id == id) {
            continue;
        }
        snapshot.workspace.sources.push(StorageSource {
            id,
            name: provider.name.clone(),
            kind: "s3".to_owned(),
            path: provider.endpoint.clone(),
            available: true,
        });
    }
    if snapshot.workspace.name.trim().is_empty() {
        snapshot.workspace.name = if settings.name.trim().is_empty() {
            "我的知识库".to_owned()
        } else {
            settings.name
        };
    }
    Ok(snapshot)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn mobile_credentials_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app_data_dir(app)?.join(".tie").join("s3-credentials");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn read_mobile_credential(app: &tauri::AppHandle, provider_id: &str) -> Result<String, String> {
    let path = mobile_credentials_dir(app)?.join(format!("{provider_id}.json"));
    fs::read_to_string(path).map_err(|_| "未找到此 S3 连接的本机密钥，请重新保存配置".to_owned())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn write_mobile_credential(app: &tauri::AppHandle, provider_id: &str, payload: &str) -> Result<(), String> {
    let path = mobile_credentials_dir(app)?.join(format!("{provider_id}.json"));
    fs::write(path, payload).map_err(|error| format!("无法保存 S3 密钥：{error}"))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn delete_mobile_credential(app: &tauri::AppHandle, provider_id: &str) -> Result<(), String> {
    let path = mobile_credentials_dir(app)?.join(format!("{provider_id}.json"));
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法删除 S3 密钥：{error}")),
    }
}
