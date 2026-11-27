use crate::common::app_data_dir;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn updater_builder() -> Result<tauri_plugin_updater::Builder, String> {
    let builder = tauri_plugin_updater::Builder::new();
    #[cfg(windows)]
    let builder = {
        let executable =
            std::env::current_exe().map_err(|error| format!("无法确定当前安装位置：{error}"))?;
        // Windows releases use NSIS. Its /D= override must be last and unquoted,
        // including when the directory contains spaces.
        builder
            .installer_arg("/TIE_CURRENT_INSTALL")
            .installer_arg(nsis_install_directory_arg(&executable)?)
    };
    Ok(builder)
}

#[cfg(any(windows, test))]
fn nsis_install_directory_arg(executable: &std::path::Path) -> Result<std::ffi::OsString, String> {
    let directory = executable
        .parent()
        .filter(|directory| !directory.as_os_str().is_empty())
        .ok_or_else(|| "无法确定当前安装位置，请下载安装包手动安装".to_owned())?;
    let mut argument = std::ffi::OsString::from("/D=");
    argument.push(directory);
    Ok(argument)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressPayload {
    downloaded: u64,
    total: Option<u64>,
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        .collect();
    if cleaned.is_empty() {
        "tie-update.bin".to_owned()
    } else {
        cleaned
    }
}

#[tauri::command]
pub async fn download_update_file(
    app: AppHandle,
    url: String,
    file_name: String,
) -> Result<String, String> {
    let directory = app_data_dir(&app)?.join("updates");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let destination = directory.join(sanitize_file_name(&file_name));

    let client = reqwest::Client::builder()
        .user_agent("Tie-Updater")
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url.trim())
        .send()
        .await
        .map_err(|error| format!("下载失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载失败：HTTP {}", response.status()));
    }

    let total = response.content_length();
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&destination)
        .await
        .map_err(|error| format!("无法写入更新文件：{error}"))?;
    let mut downloaded = 0u64;

    let _ = app.emit(
        "app-update-download-progress",
        DownloadProgressPayload {
            downloaded: 0,
            total,
        },
    );

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("下载中断：{error}"))?;
        use tokio::io::AsyncWriteExt;
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("写入更新文件失败：{error}"))?;
        downloaded += chunk.len() as u64;
        let _ = app.emit(
            "app-update-download-progress",
            DownloadProgressPayload { downloaded, total },
        );
    }

    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::nsis_install_directory_arg;
    use std::{ffi::OsString, path::PathBuf};

    #[test]
    fn update_uses_the_running_executable_directory_including_spaces_and_unicode() {
        #[cfg(windows)]
        let directory = PathBuf::from(r"D:\自定义软件\Tie Installed Here");
        #[cfg(not(windows))]
        let directory = PathBuf::from("/custom/自定义软件/Tie Installed Here");
        let executable = directory.join("tie.exe");
        let mut expected = OsString::from("/D=");
        expected.push(&directory);
        assert_eq!(nsis_install_directory_arg(&executable).unwrap(), expected);
    }

    #[test]
    fn missing_install_directory_does_not_fall_back_to_a_default_directory() {
        assert!(nsis_install_directory_arg(std::path::Path::new("tie.exe")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn update_preserves_a_network_install_directory() {
        assert_eq!(
            nsis_install_directory_arg(std::path::Path::new(r"\\fileserver\Apps\Tie\tie.exe"))
                .unwrap(),
            OsString::from(r"/D=\\fileserver\Apps\Tie")
        );
    }
}
