use super::read_s3_credential_payload;
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tie_storage::fs_path;
use tie_storage::file_meta;
use tie_storage::s3::{self as s3_store, S3Connection, WorkspaceFileResource};

fn now_stamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

fn new_file_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mix = (nanos as u64) ^ ((std::process::id() as u64) << 32).wrapping_add(nanos as u64);
    format!("file_{mix:016x}")
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn guess_mime(ext: &str, is_directory: bool) -> String {
    if is_directory {
        return "inode/directory".into();
    }
    match ext {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
    .into()
}

fn sanitize_stored_name(ext: &str) -> String {
    let clean = ext
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    if clean.is_empty() {
        "original.bin".into()
    } else {
        format!("original.{clean}")
    }
}

fn resolve_abs_path(raw: &str) -> Result<PathBuf, String> {
    let input = PathBuf::from(raw.trim());
    if !input.exists() {
        return Err(format!("路径不存在：{}", input.display()));
    }
    let canonical = fs::canonicalize(&input).unwrap_or(input);
    Ok(fs_path::strip_extended_length_prefix(&canonical))
}

fn patch_local_exists(mut resource: WorkspaceFileResource) -> WorkspaceFileResource {
    if resource.mode == "link" {
        let candidate = if resource.open_path.trim().is_empty() {
            resource.source_path.clone()
        } else {
            resource.open_path.clone()
        };
        if crate::saf::is_content_uri(&candidate) {
            resource.exists = crate::saf::uri_exists(&candidate);
            resource.open_path = candidate;
        } else {
            let path = PathBuf::from(&candidate);
            resource.exists = path.exists();
            resource.open_path = fs_path::for_shell_open(&path)
                .to_string_lossy()
                .into_owned();
        }
    }
    resource
}

#[tauri::command]
pub(crate) async fn list_s3_workspace_files(
    app: tauri::AppHandle,
    connection: S3Connection,
) -> Result<Vec<WorkspaceFileResource>, String> {
    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    let files = s3_store::list_s3_workspace_files(&connection, &payload).await?;
    Ok(files.into_iter().map(patch_local_exists).collect())
}

#[tauri::command]
pub(crate) async fn resolve_s3_workspace_file(
    app: tauri::AppHandle,
    connection: S3Connection,
    file_id: String,
) -> Result<WorkspaceFileResource, String> {
    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    let resource = s3_store::resolve_s3_workspace_file(&connection, &payload, &file_id).await?;
    Ok(patch_local_exists(resource))
}

#[tauri::command]
pub(crate) async fn ingest_s3_workspace_file(
    app: tauri::AppHandle,
    connection: S3Connection,
    path: String,
    mode: String,
    title: Option<String>,
    source_id: Option<String>,
    file_id: Option<String>,
) -> Result<WorkspaceFileResource, String> {
    let normalized_mode = match mode.trim() {
        "copy" | "link" => mode.trim().to_owned(),
        _ => return Err("mode 必须是 copy 或 link".into()),
    };
    let (abs_path, abs_display, is_directory, file_size, android_uri) = if crate::saf::is_content_uri(&path) {
        let uri = path.trim().to_owned();
        let stat = crate::saf::uri_stat(&uri)?;
        if !stat.exists {
            return Err("找不到所选文档".into());
        }
        if normalized_mode == "copy" && stat.is_directory {
            return Err("远程存储源不能导入目录副本，请改用登记".into());
        }
        if normalized_mode == "copy" && stat.size > 20 * 1024 * 1024 {
            return Err("远程导入不能超过 20 MB，请改用登记或缩小文件".into());
        }
        let readable = if normalized_mode == "copy" {
            crate::saf::materialize_content_uri(&uri)?
        } else {
            PathBuf::from(&uri)
        };
        (readable, uri.clone(), stat.is_directory, stat.size, Some(uri))
    } else {
        let abs_path = resolve_abs_path(&path)?;
        let meta_fs = fs::metadata(&abs_path).map_err(|error| error.to_string())?;
        let is_directory = meta_fs.is_dir();
        if !is_directory && !meta_fs.is_file() {
            return Err(format!("不是普通文件或目录：{}", abs_path.display()));
        }
        let abs_display = abs_path.to_string_lossy().into_owned();
        (abs_path, abs_display, is_directory, if is_directory { 0 } else { meta_fs.len() }, None)
    };
    if normalized_mode == "copy" && is_directory {
        return Err("远程存储源不能导入目录副本，请改用登记".into());
    }
    if normalized_mode == "copy" && file_size > 20 * 1024 * 1024 {
        return Err("远程导入不能超过 20 MB，请改用登记或缩小文件".into());
    }

    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    let resolved_source = source_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_owned())
        .unwrap_or_else(|| format!("s3:{}", connection.provider_id));
    let locator = android_uri.as_ref().map(|uri| {
        json!({
            "type": "android",
            "androidUri": uri,
            "displayPath": abs_path.file_name().and_then(|name| name.to_str()).unwrap_or("document"),
        })
    });
    if let Some(id) = file_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        if normalized_mode != "link" {
            return Err("只能重新绑定绝对登记".into());
        }
        let existing = s3_store::resolve_s3_workspace_file(&connection, &payload, id).await?;
        if existing.mode != "link" {
            return Err("副本不能重新绑定，请重新导入".into());
        }
        let kind = if is_directory { "directory" } else { "file" };
        let ext = if is_directory {
            "dir".to_owned()
        } else {
            extension_of(&abs_path)
        };
        let mime = guess_mime(&ext, is_directory);
        let base_title = title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_owned())
            .unwrap_or(existing.title);
        let mut raw = json!({
            "id": existing.id,
            "title": base_title,
            "kind": kind,
            "mode": "link",
            "mime": mime,
            "ext": ext,
            "size": file_size,
            "sourcePath": abs_display,
            "storedPath": abs_display,
            "createdAt": existing.updated_at,
            "updatedAt": now_stamp(),
            "sourceId": resolved_source,
        });
        if let Some(locator) = locator {
            raw["locator"] = locator;
        }
        let meta = file_meta::normalize_file_meta(&raw, Some(&resolved_source));
        let resource = s3_store::upsert_s3_workspace_file_meta(&connection, &payload, meta).await?;
        return Ok(patch_local_exists(resource));
    }
    let existing = s3_store::list_s3_workspace_files(&connection, &payload).await?;
    if let Some(found) = existing.into_iter().find(|item| {
        item.mode == normalized_mode && (item.source_path == abs_display || item.open_path == abs_display)
    }) {
        return Ok(patch_local_exists(found));
    }

    let kind = if is_directory { "directory" } else { "file" };
    let ext = if is_directory {
        "dir".to_owned()
    } else {
        extension_of(&abs_path)
    };
    let mime = guess_mime(&ext, is_directory);
    let id = new_file_id();
    let now = now_stamp();
    let base_title = title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_owned())
        .unwrap_or_else(|| {
            abs_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&id)
                .to_owned()
        });
    let stored_name = sanitize_stored_name(&ext);
    let stored_path = if normalized_mode == "copy" {
        let data = fs::read(&abs_path).map_err(|error| error.to_string())?;
        if android_uri.is_some() {
            let _ = fs::remove_file(&abs_path);
        }
        s3_store::put_s3_workspace_file_blob(
            &connection,
            &payload,
            &id,
            &stored_name,
            data,
        )
        .await?;
        format!(".tie/files/{id}/{stored_name}")
    } else {
        abs_display.clone()
    };

    let mut raw = json!({
        "id": id,
        "title": base_title,
        "kind": kind,
        "mode": normalized_mode,
        "mime": mime,
        "ext": ext,
        "size": file_size,
        "sourcePath": abs_display,
        "storedPath": stored_path,
        "createdAt": now,
        "updatedAt": now,
    });
    if let Some(locator) = locator {
        raw["locator"] = locator;
    }
    let meta = file_meta::normalize_file_meta(&raw, Some(&resolved_source));
    let resource = s3_store::upsert_s3_workspace_file_meta(&connection, &payload, meta).await?;
    Ok(patch_local_exists(resource))
}

#[tauri::command]
pub(crate) async fn prepare_s3_workspace_file(
    app: tauri::AppHandle,
    connection: S3Connection,
    file_id: String,
) -> Result<String, String> {
    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    let resource = patch_local_exists(
        s3_store::resolve_s3_workspace_file(&connection, &payload, &file_id).await?,
    );
    if resource.mode == "link" {
        if !resource.exists {
            return Err(format!(
                "找不到已登记的文件：{}",
                resource.open_path
            ));
        }
        return Ok(resource.open_path);
    }
    if !resource.exists {
        return Err(format!(
            "副本缺失：{}",
            resource.stored_path
        ));
    }
    let bytes =
        s3_store::read_s3_workspace_file_bytes(&connection, &payload, &resource.id).await?;
    let name = Path::new(&resource.stored_path)
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or("original.bin");
    let dir = std::env::temp_dir()
        .join("tie-s3-files")
        .join(&connection.provider_id)
        .join(&resource.id);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let dest = dir.join(name);
    fs::write(&dest, bytes).map_err(|error| error.to_string())?;
    Ok(fs_path::for_shell_open(&dest).to_string_lossy().into_owned())
}
