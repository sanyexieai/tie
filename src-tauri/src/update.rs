use crate::common::app_data_dir;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

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
