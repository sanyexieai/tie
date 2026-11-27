use crate::common::{app_data_dir, load_settings, load_workspace_snapshot, save_settings, workspace_sources};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use tie_storage::fs_path;
use tie_storage::file_meta;
use tie_storage::identity::load_or_create_device_identity;
// Page load/save goes through `tie_storage::local` (= `tie-local`): same frontmatter /
// history rules as the headless `tie` CLI (`LocalWorkspace`). Multi-source fan-out stays here.
use tie_storage::local::{
    io, register_storage_source, resolve_directory_path, FileRegistry, Page,
    PageRevision, WorkspaceSettings, WorkspaceSnapshot,
};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileResource {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub mode: String,
    pub ext: String,
    pub mime: String,
    pub size: u64,
    pub source_path: String,
    pub stored_path: String,
    pub open_path: String,
    pub exists: bool,
    pub updated_at: String,
    pub device_bindings: Value,
    pub binding_state: String,
    pub current_device_id: Option<String>,
}

fn files_index_path(root: &Path) -> PathBuf {
    root.join(".tie").join("files").join("index.json")
}

fn files_meta_path(root: &Path, file_id: &str) -> PathBuf {
    root.join(".tie").join("files").join(file_id).join("meta.json")
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn resource_from_meta(root: &Path, meta: &Value) -> Option<WorkspaceFileResource> {
    let id = meta.get("id")?.as_str()?.to_owned();
    let title = meta
        .get("title")
        .and_then(|item| item.as_str())
        .unwrap_or(&id)
        .to_owned();
    let mode = meta.get("mode")?.as_str()?.to_owned();
    let kind = meta
        .get("kind")
        .and_then(|item| item.as_str())
        .unwrap_or_else(|| {
            if mime_hint_is_directory(meta) || ext_hint_is_directory(meta) {
                "directory"
            } else {
                "file"
            }
        })
        .to_owned();
    let ext = meta
        .get("ext")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_owned();
    let mime = meta
        .get("mime")
        .and_then(|item| item.as_str())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let size = meta.get("size").and_then(|item| item.as_u64()).unwrap_or(0);
    let source_path = file_meta::source_path_from_meta(meta);
    let stored_path = meta
        .get("storedPath")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_owned();
    let updated_at = meta
        .get("updatedAt")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_owned();
    let root = fs_path::for_shell_open(root);
    let device = if mode == "link" { load_or_create_device_identity().ok() } else { None };
    let device_id = device.as_ref().map(|device| device.id.as_str());
    let binding_state = tie_storage::local::file_binding_state(meta, device_id);
    let binding_path = device_id.and_then(|id| tie_storage::local::file_binding_path(meta, id)).unwrap_or_default();
    let content_uri = mode == "link" && crate::saf::is_content_uri(&binding_path);
    let (open_path, exists, is_directory) = if mode == "link" && binding_state != "bound" {
        (String::new(), false, false)
    } else if content_uri {
        let uri = if mode == "copy" {
            stored_path.clone()
        } else {
            binding_path.clone()
        };
        (uri.clone(), crate::saf::uri_exists(&uri), false)
    } else {
        let open_buf = if mode == "copy" {
            tie_storage::local::portable_copy_path(&root, &stored_path).map(|path| fs_path::for_shell_open(&path))
        } else {
            let candidate = PathBuf::from(&binding_path);
            Some(fs_path::for_shell_open(&candidate))
        };
        if let Some(open_buf) = open_buf {
            let metadata = crate::path_probe::metadata(open_buf.clone());
            (
            open_buf.to_string_lossy().into_owned(),
            metadata.is_some(),
            metadata.is_some_and(|value| value.is_dir()),
            )
        } else { (String::new(), false, false) }
    };
    let kind = if content_uri {
        kind
    } else {
        if kind == "directory" || is_directory {
            "directory".to_owned()
        } else {
            "file".to_owned()
        }
    };
    Some(WorkspaceFileResource {
        id,
        title,
        kind,
        mode,
        ext,
        mime,
        size,
        source_path,
        stored_path,
        open_path,
        exists,
        updated_at,
        device_bindings: meta.get("deviceBindings").cloned().unwrap_or_else(|| json!({})),
        binding_state: binding_state.to_owned(),
        current_device_id: device.map(|device| device.id),
    })
}

fn mime_hint_is_directory(meta: &Value) -> bool {
    meta.get("mime")
        .and_then(|item| item.as_str())
        .is_some_and(|mime| mime == "inode/directory" || mime == "application/x-directory")
}

fn ext_hint_is_directory(meta: &Value) -> bool {
    meta.get("ext")
        .and_then(|item| item.as_str())
        .is_some_and(|ext| ext == "dir")
}

#[tauri::command]
pub(crate) async fn list_workspace_files(root: String) -> Result<Vec<WorkspaceFileResource>, String> {
    tauri::async_runtime::spawn_blocking(move || list_workspace_files_blocking(root))
        .await
        .map_err(|error| error.to_string())?
}

fn list_workspace_files_blocking(root: String) -> Result<Vec<WorkspaceFileResource>, String> {
    let root_path = PathBuf::from(root.trim());
    let items = FileRegistry::new(&root_path, None).list(None, None, 200)?;
    let mut out = Vec::new();
    for meta in items {
        if let Some(resource) = resource_from_meta(&root_path, &meta) {
            out.push(resource);
        }
    }
    Ok(out)
}

#[tauri::command]
pub(crate) async fn resolve_workspace_file(root: String, file_id: String) -> Result<WorkspaceFileResource, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_workspace_file_blocking(root, file_id))
        .await
        .map_err(|error| error.to_string())?
}

fn resolve_workspace_file_blocking(
    root: String,
    file_id: String,
) -> Result<WorkspaceFileResource, String> {
    let root_path = PathBuf::from(root.trim());
    let id = file_id.trim();
    if id.is_empty() {
        return Err("fileId 无效".into());
    }
    let meta = FileRegistry::new(&root_path, None)
        .get(id)?
        .ok_or_else(|| format!("文件资源不存在：{id}"))?;
    resource_from_meta(&root_path, &meta).ok_or_else(|| format!("文件资源元数据无效：{id}"))
}

fn now_iso() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    tie_storage::local::format_utc_millis_pub(millis)
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
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

fn guess_mime(ext: &str, is_directory: bool) -> String {
    if is_directory {
        return "inode/directory".into();
    }
    match ext {
        "pdf" => "application/pdf",
        "epub" => "application/epub+zip",
        "txt" | "log" | "csv" | "tsv" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
    .into()
}

fn sanitize_stored_name(ext: &str) -> String {
    let clean: String = ext
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

fn ensure_files_root(root: &Path) -> Result<PathBuf, String> {
    let files_root = root.join(".tie").join("files");
    fs::create_dir_all(&files_root).map_err(|error| error.to_string())?;
    Ok(files_root)
}

fn read_index_entries(root: &Path) -> Result<Vec<Value>, String> {
    let index = files_index_path(root);
    if !index.is_file() {
        return Ok(Vec::new());
    }
    let value = read_json_file(&index)?;
    Ok(value.as_array().cloned().unwrap_or_default())
}

fn write_index_entries(root: &Path, entries: &[Value]) -> Result<(), String> {
    ensure_files_root(root)?;
    let index = files_index_path(root);
    let raw = format!("{}\n", serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?);
    fs::write(index, raw).map_err(|error| error.to_string())
}

fn write_meta_file(root: &Path, meta: &Value) -> Result<(), String> {
    let id = meta
        .get("id")
        .and_then(|item| item.as_str())
        .ok_or_else(|| "meta.id 无效".to_string())?;
    let dir = root.join(".tie").join("files").join(id);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let raw = format!("{}\n", serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?);
    fs::write(dir.join("meta.json"), raw).map_err(|error| error.to_string())
}

fn upsert_index_entry(root: &Path, meta: &Value) -> Result<(), String> {
    let id = meta
        .get("id")
        .and_then(|item| item.as_str())
        .ok_or_else(|| "meta.id 无效".to_string())?;
    let mut entries = read_index_entries(root)?
        .into_iter()
        .filter(|entry| entry.get("id").and_then(|item| item.as_str()) != Some(id))
        .collect::<Vec<_>>();
    entries.insert(
        0,
        json!({
            "id": id,
            "title": meta.get("title").and_then(|item| item.as_str()).unwrap_or(id),
            "kind": meta.get("kind").and_then(|item| item.as_str()).unwrap_or("file"),
            "mode": meta.get("mode").and_then(|item| item.as_str()).unwrap_or("link"),
            "ext": meta.get("ext").and_then(|item| item.as_str()).unwrap_or(""),
            "mime": meta.get("mime").and_then(|item| item.as_str()).unwrap_or("application/octet-stream"),
            "size": meta.get("size").and_then(|item| item.as_u64()).unwrap_or(0),
            "updatedAt": meta.get("updatedAt").and_then(|item| item.as_str()).unwrap_or(""),
        }),
    );
    write_index_entries(root, &entries)
}

fn resolve_abs_path(raw: &str) -> Result<PathBuf, String> {
    let input = PathBuf::from(raw.trim());
    if !input.exists() {
        return Err(format!("路径不存在：{}", input.display()));
    }
    let canonical = fs::canonicalize(&input).unwrap_or(input);
    Ok(fs_path::strip_extended_length_prefix(&canonical))
}

fn find_existing_resource(
    root: &Path,
    abs_path: &Path,
    mode: &str,
) -> Result<Option<Value>, String> {
    let device = if mode == "link" { Some(load_or_create_device_identity()?) } else { None };
    let abs = abs_path.to_string_lossy();
    for entry in read_index_entries(root)? {
        let id = entry
            .get("id")
            .and_then(|item| item.as_str())
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let meta_path = files_meta_path(root, id);
        if !meta_path.is_file() {
            continue;
        }
        let meta = read_json_file(&meta_path)?;
        let meta_mode = meta.get("mode").and_then(|item| item.as_str()).unwrap_or("");
        if meta_mode != mode {
            continue;
        }
        if let Some(device) = &device {
            if tie_storage::local::file_binding_path(&meta, &device.id).as_deref() == Some(abs.as_ref()) { return Ok(Some(meta)); }
            continue;
        }
        let source = file_meta::source_path_from_meta(&meta);
        let stored = meta
            .get("storedPath")
            .and_then(|item| item.as_str())
            .unwrap_or("");
        if source == abs.as_ref() || stored == abs.as_ref() {
            return Ok(Some(meta));
        }
        let source_resolved = PathBuf::from(source);
        let source_abs = fs::canonicalize(&source_resolved)
            .map(|p| fs_path::strip_extended_length_prefix(&p))
            .unwrap_or(source_resolved);
        if source_abs == abs_path {
            return Ok(Some(meta));
        }
        if mode == "link" {
            let stored_resolved = PathBuf::from(stored);
            let stored_abs = fs::canonicalize(&stored_resolved)
                .map(|p| fs_path::strip_extended_length_prefix(&p))
                .unwrap_or(stored_resolved);
            if stored_abs == abs_path || stored == abs.as_ref() {
                return Ok(Some(meta));
            }
        }
    }
    Ok(None)
}

fn rebind_link_resource(
    root: &Path,
    file_id: &str,
    abs_path: &Path,
    title: Option<&str>,
    source_id: Option<&str>,
) -> Result<WorkspaceFileResource, String> {
    let id = file_id.trim();
    if id.is_empty() {
        return Err("fileId 无效".into());
    }
    let meta_path = files_meta_path(root, id);
    if !meta_path.is_file() {
        return Err(format!("文件资源不存在：{id}"));
    }
    let mut meta = read_json_file(&meta_path)?;
    let mode = meta
        .get("mode")
        .and_then(|item| item.as_str())
        .unwrap_or("");
    if mode != "link" {
        return Err("副本不能重新绑定，请重新导入".into());
    }
    let meta_fs = fs::metadata(abs_path).map_err(|error| error.to_string())?;
    let is_directory = meta_fs.is_dir();
    if !is_directory && !meta_fs.is_file() {
        return Err(format!("不是普通文件或目录：{}", abs_path.display()));
    }
    let kind = if is_directory { "directory" } else { "file" };
    let ext = if is_directory {
        "dir".to_owned()
    } else {
        extension_of(abs_path)
    };
    let mime = guess_mime(&ext, is_directory);
    let abs_display = abs_path.to_string_lossy().into_owned();
    let base_title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_owned())
        .or_else(|| {
            meta.get("title")
                .and_then(|item| item.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_owned())
        })
        .unwrap_or_else(|| {
            abs_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(id)
                .to_owned()
        });
    meta["title"] = json!(base_title);
    meta["kind"] = json!(kind);
    meta["ext"] = json!(ext);
    meta["mime"] = json!(mime);
    meta["size"] = json!(if is_directory {
        // rebind/link：不要递归扫目录体积
        0u64
    } else {
        meta_fs.len()
    });
    let locator = json!({
        "type": "desktop",
        "desktopPath": abs_display,
        "displayPath": abs_display,
    });
    let stamp = now_iso();
    tie_storage::local::bind_file_to_device(&mut meta, &load_or_create_device_identity()?, &abs_display, locator, &stamp);
    meta["updatedAt"] = json!(stamp);
    let meta = file_meta::normalize_file_meta(&meta, source_id);
    write_meta_file(root, &meta)?;
    upsert_index_entry(root, &meta)?;
    resource_from_meta(root, &meta).ok_or_else(|| "重新绑定后读取失败".to_string())
}

fn android_locator(uri: &str, display: &str) -> Value {
    json!({
        "type": "android",
        "androidUri": uri,
        "displayPath": display,
    })
}

fn ingest_android_uri(
    root: &Path,
    uri: &str,
    mode: &str,
    title: Option<&str>,
    source_id: Option<&str>,
    file_id: Option<&str>,
) -> Result<WorkspaceFileResource, String> {
    let stat = crate::saf::uri_stat(uri)?;
    if !stat.exists {
        return Err("找不到所选文档".into());
    }
    if mode == "copy" && stat.is_directory {
        return Err("Android 不能导入目录副本，请改用登记".into());
    }
    let display = if stat.name.trim().is_empty() {
        uri.rsplit(['/', ':']).next().unwrap_or("document").to_owned()
    } else {
        stat.name.clone()
    };
    if let Some(id) = file_id.map(str::trim).filter(|value| !value.is_empty()) {
        if mode != "link" {
            return Err("只能重新绑定绝对登记".into());
        }
        let meta_path = files_meta_path(root, id);
        if !meta_path.is_file() {
            return Err(format!("文件资源不存在：{id}"));
        }
        let mut meta = read_json_file(&meta_path)?;
        if meta.get("mode").and_then(|item| item.as_str()) != Some("link") {
            return Err("副本不能重新绑定，请重新导入".into());
        }
        let kind = if stat.is_directory { "directory" } else { "file" };
        let ext = if stat.is_directory {
            "dir".to_owned()
        } else {
            extension_of(Path::new(&display))
        };
        meta["title"] = json!(title.map(str::trim).filter(|value| !value.is_empty()).unwrap_or(&display));
        meta["kind"] = json!(kind);
        meta["ext"] = json!(ext);
        meta["mime"] = json!(if stat.mime.trim().is_empty() {
            guess_mime(&ext, stat.is_directory)
        } else {
            stat.mime.clone()
        });
        meta["size"] = json!(stat.size);
        let stamp = now_iso();
        tie_storage::local::bind_file_to_device(&mut meta, &load_or_create_device_identity()?, uri, android_locator(uri, &display), &stamp);
        meta["updatedAt"] = json!(stamp);
        let meta = file_meta::normalize_file_meta(&meta, source_id);
        write_meta_file(root, &meta)?;
        upsert_index_entry(root, &meta)?;
        return resource_from_meta(root, &meta).ok_or_else(|| "重新绑定后读取失败".to_string());
    }
    if let Some(existing) = find_existing_resource(root, Path::new(uri), mode)? {
        return resource_from_meta(root, &existing)
            .ok_or_else(|| "已有文件资源元数据无效".to_string());
    }
    let kind = if stat.is_directory { "directory" } else { "file" };
    let ext = if stat.is_directory {
        "dir".to_owned()
    } else {
        extension_of(Path::new(&display))
    };
    let mime = if stat.mime.trim().is_empty() {
        guess_mime(&ext, stat.is_directory)
    } else {
        stat.mime.clone()
    };
    let id = new_file_id();
    let now = now_iso();
    let base_title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_owned())
        .unwrap_or_else(|| display.clone());
    let stored_path = if mode == "copy" {
        let materialized = crate::saf::materialize_content_uri(uri)?;
        let dir = root.join(".tie").join("files").join(&id);
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let stored_name = sanitize_stored_name(&ext);
        let target = dir.join(&stored_name);
        fs::copy(&materialized, &target).map_err(|error| error.to_string())?;
        let _ = fs::remove_file(&materialized);
        PathBuf::from(".tie")
            .join("files")
            .join(&id)
            .join(stored_name)
            .to_string_lossy()
            .replace('\\', "/")
    } else {
        uri.to_owned()
    };
    let mut meta = json!({
        "id": id,
        "title": base_title,
        "kind": kind,
        "mode": mode,
        "mime": mime,
        "ext": ext,
        "size": stat.size,
        "sourcePath": uri,
        "storedPath": stored_path,
        "locator": android_locator(uri, &display),
        "sha256": Value::Null,
        "createdAt": now,
        "updatedAt": now,
    });
    if mode == "link" {
        tie_storage::local::bind_file_to_device(&mut meta, &load_or_create_device_identity()?, uri, android_locator(uri, &display), &now);
    }
    let meta = file_meta::normalize_file_meta(&meta, source_id);
    write_meta_file(root, &meta)?;
    upsert_index_entry(root, &meta)?;
    resource_from_meta(root, &meta).ok_or_else(|| "写入文件资源后读取失败".to_string())
}

#[tauri::command]
pub(crate) fn ingest_workspace_file(
    root: String,
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
    let root_path = PathBuf::from(root.trim());
    if root_path.as_os_str().is_empty() {
        return Err("工作区根目录无效".into());
    }
    ensure_files_root(&root_path)?;
    if crate::saf::is_content_uri(&path) {
        return ingest_android_uri(
            &root_path,
            path.trim(),
            &normalized_mode,
            title.as_deref(),
            source_id.as_deref(),
            file_id.as_deref(),
        );
    }
    let abs_path = resolve_abs_path(&path)?;
    if let Some(id) = file_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        if normalized_mode != "link" {
            return Err("只能重新绑定绝对登记".into());
        }
        return rebind_link_resource(
            &root_path,
            id,
            &abs_path,
            title.as_deref(),
            source_id.as_deref(),
        );
    }
    // Desktop link/copy shares tie-local FileRegistry with the CLI / MCP.
    let meta = FileRegistry::new(&root_path, source_id.as_deref()).ingest(
        &normalized_mode,
        &abs_path,
        title.as_deref(),
    )?;
    resource_from_meta(&root_path, &meta).ok_or_else(|| "写入文件资源后读取失败".to_string())
}

#[tauri::command]
pub(crate) async fn native_path_exists(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || native_path_exists_blocking(path))
        .await
        .unwrap_or(false)
}

fn native_path_exists_blocking(path: String) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return false;
    }
    if crate::saf::is_content_uri(trimmed) {
        return crate::saf::uri_exists(trimmed);
    }
    crate::path_probe::metadata(PathBuf::from(trimmed)).is_some()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePathStat {
    pub exists: bool,
    pub is_directory: bool,
    pub size: u64,
}

#[tauri::command]
pub(crate) fn native_path_stat(path: String) -> Result<NativePathStat, String> {
    if crate::saf::is_content_uri(&path) {
        let stat = crate::saf::uri_stat(path.trim())?;
        return Ok(NativePathStat {
            exists: stat.exists,
            is_directory: stat.is_directory,
            size: stat.size,
        });
    }
    let abs = resolve_abs_path(&path)?;
    let meta = fs::metadata(&abs).map_err(|error| error.to_string())?;
    Ok(NativePathStat {
        exists: true,
        is_directory: meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
    })
}

#[tauri::command]
pub(crate) fn read_native_file_bytes(path: String) -> Result<Vec<u8>, String> {
    if crate::saf::is_content_uri(&path) {
        let temp = crate::saf::materialize_content_uri(path.trim())?;
        let data = fs::read(&temp).map_err(|error| error.to_string())?;
        let _ = fs::remove_file(&temp);
        return Ok(data);
    }
    let abs = resolve_abs_path(&path)?;
    let meta = fs::metadata(&abs).map_err(|error| error.to_string())?;
    if !meta.is_file() {
        return Err("只能读取普通文件".into());
    }
    if meta.len() > 20 * 1024 * 1024 {
        return Err("远程导入不能超过 20 MB，请改用登记或缩小文件".into());
    }
    fs::read(&abs).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn write_temp_file_bytes(file_name: String, data: Vec<u8>) -> Result<String, String> {
    if data.len() > 20 * 1024 * 1024 {
        return Err("缓存文件不能超过 20 MB".into());
    }
    let safe = PathBuf::from(file_name.trim())
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .unwrap_or("download.bin")
        .to_owned();
    let dir = std::env::temp_dir().join("tie-open-files");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let dest = dir.join(format!(
        "{}_{safe}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    fs::write(&dest, data).map_err(|error| error.to_string())?;
    Ok(fs_path::for_shell_open(&dest).to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) async fn load_workspace(app: AppHandle) -> Result<WorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        load_workspace_snapshot(&app)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn add_storage_source(
    app: AppHandle,
    path: String,
    kind: Option<String>,
) -> Result<WorkspaceSnapshot, String> {
    let root = resolve_directory_path(&path)?;
    let kind = kind.unwrap_or_else(|| "local".to_owned());
    register_storage_source(&app_data_dir(&app)?, root, kind)?;
    load_workspace_snapshot(&app)
}

#[tauri::command]
pub(crate) fn page_file_path(
    app: AppHandle,
    page_id: String,
    storage_source_id: String,
) -> Result<String, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if crate::desktop::temporary::is_temporary(&storage_source_id) {
        return crate::desktop::temporary::page_file_path(&app, &storage_source_id, &page_id)
            .map(|path| fs_path::for_shell_open(&path).to_string_lossy().into_owned());
    }
    let (sources, _) = workspace_sources(&app)?;
    let source = sources
        .iter()
        .find(|source| source.id == storage_source_id)
        .ok_or("页面所属存储源不存在")?;
    let path = tie_storage::local::find_page_file(Path::new(&source.path), &page_id)
        .ok_or("页面文件不存在")?;
    Ok(fs_path::for_shell_open(&path).to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) fn export_tie_file(
    app: AppHandle,
    page_id: String,
    storage_source_id: String,
    title: String,
    out_path: String,
) -> Result<String, String> {
    let (sources, _) = workspace_sources(&app)?;
    let source = sources
        .iter()
        .find(|source| source.id == storage_source_id)
        .ok_or("页面所属存储源不存在")?;
    let path = tie_storage::local::write_exported_tie(
        Path::new(out_path.trim()),
        Path::new(&source.path),
        &storage_source_id,
        &page_id,
        &title,
    )?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub(crate) async fn save_page(
    app: AppHandle,
    page: Page,
    expected_updated_at: Option<String>,
    write_source_id: Option<String>,
    origin: Option<tie_storage::identity::ChangeOrigin>,
) -> Result<Page, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let origin = match origin { Some(origin) => origin, None => crate::common::settings::app_change_origin(&app)? };
        tie_storage::local::changes::with_change_context(origin, None, false, || save_page_blocking(app, page, expected_updated_at, write_source_id))
    })
        .await.map_err(|error| error.to_string())?
}

fn save_page_blocking(app: AppHandle, page: Page, expected_updated_at: Option<String>, write_source_id: Option<String>) -> Result<Page, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if crate::desktop::temporary::is_temporary(&page.storage_source_id)
        || write_source_id.as_deref().is_some_and(crate::desktop::temporary::is_temporary) {
        if write_source_id.as_deref().is_some_and(|source| source != page.storage_source_id) {
            return Err(crate::desktop::temporary::unsupported());
        }
        return crate::desktop::temporary::save_page(&app, page, expected_updated_at.as_deref());
    }
    let (sources, _) = workspace_sources(&app)?;
    io::save_page(
        &sources,
        page,
        expected_updated_at.as_deref(),
        write_source_id.as_deref(),
    )
}

#[tauri::command]
pub(crate) fn list_file_page_assets(app: AppHandle, page: Page) -> Result<Vec<String>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if crate::desktop::temporary::is_temporary(&page.storage_source_id) { return Ok(Vec::new()); }
    let (sources, _) = workspace_sources(&app)?;
    io::list_file_page_assets(&page, &sources)
}

#[tauri::command]
pub(crate) fn list_page_revisions(
    app: AppHandle,
    page_id: String,
    storage_source_id: String,
) -> Result<Vec<PageRevision>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if crate::desktop::temporary::is_temporary(&storage_source_id) { return Ok(Vec::new()); }
    let (sources, _) = workspace_sources(&app)?;
    io::list_page_revisions(&sources, &page_id, &storage_source_id)
}

fn protection_workspace(app: &AppHandle, source_id: &str) -> Result<tie_storage::local::LocalWorkspace, String> {
    let (sources, _) = workspace_sources(app)?;
    let source = sources.iter().find(|source| source.id == source_id).ok_or("页面所属工作区不存在")?;
    if crate::saf::is_content_uri(&source.path) { return Err("当前目录授权方式暂不支持页面加密转换，请使用应用内工作区或本地文件夹".into()); }
    tie_storage::local::LocalWorkspace::open(&source.path, Some(source_id))
}

#[tauri::command]
pub(crate) async fn read_page_protection_bundle(app: AppHandle, source_id: String, page_id: String) -> Result<tie_storage::local::ProtectionBundle, String> {
    tauri::async_runtime::spawn_blocking(move || protection_workspace(&app, &source_id)?.protection_bundle(&page_id))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn replace_page_protection_bundle(app: AppHandle, source_id: String, bundle: tie_storage::local::ProtectionBundle, expected_updated_at: Option<String>) -> Result<Page, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let origin = crate::common::settings::app_change_origin(&app)?;
        tie_storage::local::changes::with_change_context(origin, None, false, || protection_workspace(&app, &source_id)?.replace_page_protection(bundle, expected_updated_at.as_deref()))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn read_page_revision(
    app: AppHandle,
    page: Page,
    revision_id: String,
) -> Result<Page, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if crate::desktop::temporary::is_temporary(&page.storage_source_id) { return Err(crate::desktop::temporary::unsupported()); }
    let (sources, _) = workspace_sources(&app)?;
    io::read_page_revision(&sources, &page, &revision_id)
}

#[tauri::command]
pub(crate) async fn restore_page_revision(
    app: AppHandle,
    page: Page,
    revision_id: String,
    origin: Option<tie_storage::identity::ChangeOrigin>,
) -> Result<Page, String> {
    tauri::async_runtime::spawn_blocking(move || {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if crate::desktop::temporary::is_temporary(&page.storage_source_id) { return Err(crate::desktop::temporary::unsupported()); }
    let (sources, _) = workspace_sources(&app)?;
    let origin = match origin { Some(origin) => origin, None => crate::common::settings::app_change_origin(&app)? };
    tie_storage::local::changes::with_change_context(origin, Some("restore"), false, || io::restore_page_revision(&sources, page, &revision_id))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn export_page_markdown(page: Page, target_path: String) -> Result<(), String> {
    io::export_page_markdown(&page, &target_path)
}

#[tauri::command]
pub(crate) async fn permanently_delete_pages(app: AppHandle, pages: Vec<Page>, origin: Option<tie_storage::identity::ChangeOrigin>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if pages.iter().any(|page| crate::desktop::temporary::is_temporary(&page.storage_source_id)) { return Err(crate::desktop::temporary::unsupported()); }
    let (sources, _) = workspace_sources(&app)?;
    let origin = match origin { Some(origin) => origin, None => crate::common::settings::app_change_origin(&app)? };
    tie_storage::local::changes::with_change_context(origin, None, false, || io::permanently_delete_pages(&sources, &pages))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn remove_storage_source(
    app: AppHandle,
    source_id: String,
) -> Result<WorkspaceSnapshot, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if crate::desktop::temporary::is_temporary(&source_id) {
        crate::desktop::temporary::close_source(&app, &source_id)?;
        return load_workspace_snapshot(&app);
    }
    let existing_settings = load_settings(&app)?;
    let (mut sources, _) = workspace_sources(&app)?;
    if sources.len() <= 1 {
        return Err("至少需要保留一个存储源".to_owned());
    }
    if !sources.iter().any(|source| source.id == source_id) {
        return Err("存储源不存在".to_owned());
    }
    for source in &sources {
        if source.id != source_id {
            continue;
        }
        let pages_dir = std::path::PathBuf::from(&source.path).join("pages");
        let entries = std::fs::read_dir(pages_dir)
            .map_err(|error| format!("无法确认该存储源是否为空，请恢复访问后重试：{error}"))?;
        if entries.filter_map(Result::ok).any(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "md")
        }) {
            return Err("该存储源仍包含页面，请先迁移页面后再断开".to_owned());
        }
    }
    sources.retain(|source| source.id != source_id);
    save_settings(
        &app,
        &WorkspaceSettings {
            name: existing_settings.name,
            path: String::new(),
            kind: String::new(),
            sources,
            s3_providers: existing_settings.s3_providers,
        },
    )?;
    load_workspace_snapshot(&app)
}

#[tauri::command]
pub(crate) fn rename_storage_source(
    app: AppHandle,
    source_id: String,
    name: String,
) -> Result<WorkspaceSnapshot, String> {
    let clean_name = name.trim();
    if clean_name.is_empty() || clean_name.chars().count() > 80 {
        return Err("存储源名称需为 1 至 80 个字符".to_owned());
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if crate::desktop::temporary::is_temporary(&source_id) {
        crate::desktop::temporary::rename_source(&app, &source_id, clean_name)?;
        return load_workspace_snapshot(&app);
    }
    let existing_settings = load_settings(&app)?;
    let (mut sources, _) = workspace_sources(&app)?;
    let source = sources
        .iter_mut()
        .find(|source| source.id == source_id)
        .ok_or("存储源不存在")?;
    source.name = clean_name.to_owned();
    save_settings(
        &app,
        &WorkspaceSettings {
            name: existing_settings.name,
            path: String::new(),
            kind: String::new(),
            sources,
            s3_providers: existing_settings.s3_providers,
        },
    )?;
    load_workspace_snapshot(&app)
}

#[tauri::command]
pub(crate) fn rename_workspace(app: AppHandle, name: String) -> Result<WorkspaceSnapshot, String> {
    let clean_name = name.trim();
    if clean_name.is_empty() || clean_name.chars().count() > 80 {
        return Err("工作区名称需为 1 至 80 个字符".to_owned());
    }
    let mut settings = load_settings(&app)?;
    settings.name = clean_name.to_owned();
    save_settings(&app, &settings)?;
    load_workspace_snapshot(&app)
}

#[tauri::command]
pub(crate) fn save_file_page_asset(
    app: AppHandle,
    page: Page,
    file_name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if crate::desktop::temporary::is_temporary(&page.storage_source_id) { return Err(crate::desktop::temporary::unsupported()); }
    let (sources, _) = workspace_sources(&app)?;
    io::save_file_page_asset(&sources, &page, &file_name, &data)
}

#[tauri::command]
pub(crate) fn read_file_page_asset(
    app: AppHandle,
    page: Page,
    asset_name: String,
) -> Result<Vec<u8>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if crate::desktop::temporary::is_temporary(&page.storage_source_id) { return Err(crate::desktop::temporary::unsupported()); }
    let (sources, _) = workspace_sources(&app)?;
    io::read_file_page_asset(&sources, &page, &asset_name)
}

#[cfg(test)]
mod offline_resource_tests {
    use super::*;

    #[test]
    fn unbound_link_keeps_identity_and_directory_hint_without_an_open_path() {
        let meta = json!({"id":"file_offline", "title":"离线目录", "mode":"link",
            "kind":"directory", "sourcePath":"/tie-test-missing-device/folder"});
        let resource = resource_from_meta(Path::new("/tmp"), &meta).unwrap();
        assert_eq!(resource.id, "file_offline");
        assert_eq!(resource.kind, "directory");
        assert!(resource.open_path.is_empty());
        assert_eq!(resource.binding_state, "unbound");
        assert_eq!(resource.source_path, "/tie-test-missing-device/folder");
        assert!(!resource.exists);
    }
}
