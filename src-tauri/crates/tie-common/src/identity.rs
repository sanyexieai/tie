use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceIdentity {
    pub id: String,
    pub name: String,
    pub platform: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChangeOrigin {
    pub client_id: String,
    pub client_name: String,
    pub client_version: String,
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub actor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}

pub fn app_data_dir() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("TIE_APP_DATA").filter(|value| !value.is_empty()) {
        return Ok(value.into());
    }
    #[cfg(windows)]
    {
        return std::env::var_os("APPDATA")
            .map(|value| PathBuf::from(value).join("com.tie.knowledge"))
            .ok_or("找不到应用数据目录".into());
    }
    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME")
            .map(|value| PathBuf::from(value).join("Library/Application Support/com.tie.knowledge"))
            .ok_or("找不到应用数据目录".into());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|value| PathBuf::from(value).join(".local/share"))
            })
            .map(|root| root.join("com.tie.knowledge"))
            .ok_or("找不到应用数据目录".into())
    }
}

pub fn load_or_create_device_identity() -> Result<DeviceIdentity, String> {
    load_or_create_device_identity_at(&app_data_dir()?)
}

pub fn load_or_create_device_identity_at(data_dir: &Path) -> Result<DeviceIdentity, String> {
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let path = data_dir.join("device.json");
    if path.exists() {
        return serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let id = format!("dev_{stamp:x}_{:x}", std::process::id());
    let device = DeviceIdentity {
        name: std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .ok()
            .filter(|name| !name.trim().is_empty())
            .or_else(|| {
                fs::read_to_string("/etc/hostname")
                    .ok()
                    .map(|name| name.trim().to_owned())
                    .filter(|name| !name.is_empty())
            })
            .unwrap_or_else(|| format!("Device-{}", &id[id.len().saturating_sub(8)..])),
        id,
        platform: std::env::consts::OS.into(),
    };
    let temporary = data_dir.join(format!("device-{stamp:x}-{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(&device).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    drop(file);
    let linked = fs::hard_link(&temporary, &path);
    let _ = fs::remove_file(&temporary);
    match linked {
        Ok(()) => Ok(device),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

pub fn local_change_origin(
    client_id: &str,
    client_name: &str,
    client_version: &str,
) -> Result<ChangeOrigin, String> {
    let device = load_or_create_device_identity()?;
    Ok(ChangeOrigin {
        client_id: client_id.into(),
        client_name: client_name.into(),
        client_version: client_version.into(),
        device_id: device.id,
        device_name: device.name,
        platform: device.platform,
        actor: std::env::var("TIE_ACTOR")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| client_name.into()),
        user_id: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_is_stable_private_and_complete_during_concurrent_creation() {
        let root = std::env::temp_dir().join(format!(
            "tie-device-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let threads = (0..8)
            .map(|_| {
                let root = root.clone();
                std::thread::spawn(move || load_or_create_device_identity_at(&root).unwrap())
            })
            .collect::<Vec<_>>();
        let devices = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert!(devices.iter().all(|device| device == &devices[0]));
        assert!(!devices[0].name.is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.join("device.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
