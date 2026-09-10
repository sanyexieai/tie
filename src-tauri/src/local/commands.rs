use crate::common::{app_data_dir, load_settings, save_settings, workspace_sources};
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
use tie_storage::local::{
    io, load_file_workspace, register_storage_source, resolve_directory_path, Page, PageRevision,
    WorkspaceSettings, WorkspaceSnapshot,
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
    let content_uri = crate::saf::is_content_uri(&source_path) || crate::saf::is_content_uri(&stored_path);
    let (open_path, exists) = if content_uri {
        let uri = if crate::saf::is_content_uri(&stored_path) {
            stored_path.clone()
        } else {
            source_path.clone()
        };
        (uri.clone(), crate::saf::uri_exists(&uri))
    } else {
        let open_buf = if mode == "copy" {
            let stored = PathBuf::from(stored_path.replace('\\', "/"));
            if stored.is_absolute() {
                fs_path::for_shell_open(&stored)
            } else {
                fs_path::for_shell_open(&root.join(stored))
            }
        } else {
            let candidate = if stored_path.trim().is_empty() {
                PathBuf::from(&source_path)
            } else {
                PathBuf::from(&stored_path)
            };
            fs_path::for_shell_open(&candidate)
        };
        (
            open_buf.to_string_lossy().into_owned(),
            open_buf.exists(),
        )
    };
    let kind = if content_uri {
        kind
    } else {
        let open_buf = PathBuf::from(&open_path);
        if kind == "directory" || open_buf.is_dir() {
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
pub(crate) fn list_workspace_files(root: String) -> Result<Vec<WorkspaceFileResource>, String> {
    let root_path = PathBuf::from(root.trim());
    let index = files_index_path(&root_path);
    if !index.is_file() {
        return Ok(Vec::new());
    }
    let value = read_json_file(&index)?;
    let entries = value.as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for entry in entries {
        let id = entry
            .get("id")
            .and_then(|item| item.as_str())
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let meta_path = files_meta_path(&root_path, id);
        if !meta_path.is_file() {
            continue;
        }
        if let Ok(meta) = read_json_file(&meta_path) {
            if let Some(resource) = resource_from_meta(&root_path, &meta) {
                out.push(resource);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub(crate) fn resolve_workspace_file(
    root: String,
    file_id: String,
) -> Result<WorkspaceFileResource, String> {
    let root_path = PathBuf::from(root.trim());
    let id = file_id.trim();
    if id.is_empty() {
        return Err("fileId 无效".into());
    }
    let meta_path = files_meta_path(&root_path, id);
    if !meta_path.is_file() {
        return Err(format!("文件资源不存在：{id}"));
    }
    let meta = read_json_file(&meta_path)?;
    resource_from_meta(&root_path, &meta).ok_or_else(|| format!("文件资源元数据无效：{id}"))
}

fn now_iso() -> String {
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

const MAX_COPY_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_COPY_DIR_BYTES: u64 = 50 * 1024 * 1024;
const MAX_COPY_DIR_FILES: u64 = 200;
const MAX_COPY_DIR_DEPTH: u32 = 8;

fn assert_copy_file_size(size: u64) -> Result<(), String> {
    if size > MAX_COPY_FILE_BYTES {
        return Err("导入文件不能超过 50 MB，请改用登记（绝对链接）".into());
    }
    Ok(())
}

fn directory_stats_for_copy(dir: &Path) -> Result<(u64, u64, u64), String> {
    fn walk(
        current: &Path,
        depth: u32,
        size: &mut u64,
        files: &mut u64,
        dirs: &mut u64,
    ) -> Result<(), String> {
        if depth > MAX_COPY_DIR_DEPTH {
            return Err(format!(
                "导入目录不能超过 {MAX_COPY_DIR_DEPTH} 层，请改用登记或缩小范围"
            ));
        }
        let entries = fs::read_dir(current).map_err(|error| error.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_dir() {
                *dirs += 1;
                walk(&entry.path(), depth + 1, size, files, dirs)?;
            } else if file_type.is_file() {
                *files += 1;
                if *files > MAX_COPY_DIR_FILES {
                    return Err(format!(
                        "导入目录不能超过 {MAX_COPY_DIR_FILES} 个文件，请改用登记或缩小范围"
                    ));
                }
                if let Ok(meta) = entry.metadata() {
                    *size += meta.len();
                }
                if *size > MAX_COPY_DIR_BYTES {
                    return Err("导入目录不能超过 50 MB，请改用登记或缩小范围".into());
                }
            }
        }
        Ok(())
    }
    let mut size = 0u64;
    let mut files = 0u64;
    let mut dirs = 0u64;
    walk(dir, 1, &mut size, &mut files, &mut dirs)?;
    Ok((size, files, dirs))
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(from).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let target = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn directory_preview(dir: &Path, max_entries: usize) -> Option<String> {
    let mut names = Vec::new();
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten().take(max_entries) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let label = if entry.path().is_dir() {
            format!("{name}/")
        } else {
            name
        };
        names.push(label);
    }
    if names.is_empty() {
        return Some("(空目录)".into());
    }
    let total = fs::read_dir(dir).ok()?.count();
    let mut preview = names.join("\n");
    if total > max_entries {
        preview.push_str("\n…");
    }
    Some(preview)
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
    meta["sourcePath"] = json!(abs_display);
    meta["storedPath"] = json!(abs_display);
    meta["locator"] = json!({
        "type": "desktop",
        "desktopPath": abs_display,
        "displayPath": abs_display,
    });
    meta["updatedAt"] = json!(now_iso());
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
        meta["sourcePath"] = json!(uri);
        meta["storedPath"] = json!(uri);
        meta["locator"] = android_locator(uri, &display);
        meta["updatedAt"] = json!(now_iso());
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
    let meta = json!({
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
    let meta_fs = fs::metadata(&abs_path).map_err(|error| error.to_string())?;
    let is_directory = meta_fs.is_dir();
    if !is_directory && !meta_fs.is_file() {
        return Err(format!("不是普通文件或目录：{}", abs_path.display()));
    }
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
    if let Some(existing) = find_existing_resource(&root_path, &abs_path, &normalized_mode)? {
        return resource_from_meta(&root_path, &existing)
            .ok_or_else(|| "已有文件资源元数据无效".to_string());
    }

    let kind = if is_directory { "directory" } else { "file" };
    let ext = if is_directory {
        "dir".to_owned()
    } else {
        extension_of(&abs_path)
    };
    let mime = guess_mime(&ext, is_directory);
    let (size, entry_count) = if is_directory {
        let (size, files, dirs) = if normalized_mode == "copy" {
            directory_stats_for_copy(&abs_path)?
        } else {
            // link 只登记路径，禁止递归扫树（模型库等 TB 级目录会卡死 UI / 启动迁移）
            (0u64, 0u64, 0u64)
        };
        (
            size,
            if normalized_mode == "copy" {
                Some(json!({ "files": files, "dirs": dirs }))
            } else {
                None
            },
        )
    } else {
        if normalized_mode == "copy" {
            assert_copy_file_size(meta_fs.len())?;
        }
        (meta_fs.len(), None)
    };
    let id = new_file_id();
    let now = now_iso();
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
    let abs_display = abs_path.to_string_lossy().into_owned();
    let stored_path = if normalized_mode == "copy" {
        let dir = root_path.join(".tie").join("files").join(&id);
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        if is_directory {
            let target = dir.join("original");
            copy_dir_recursive(&abs_path, &target)?;
            PathBuf::from(".tie")
                .join("files")
                .join(&id)
                .join("original")
                .to_string_lossy()
                .replace('\\', "/")
        } else {
            let stored_name = sanitize_stored_name(&ext);
            let target = dir.join(&stored_name);
            fs::copy(&abs_path, &target).map_err(|error| error.to_string())?;
            PathBuf::from(".tie")
                .join("files")
                .join(&id)
                .join(stored_name)
                .to_string_lossy()
                .replace('\\', "/")
        }
    } else {
        abs_display.clone()
    };

    let preview = if is_directory {
        directory_preview(&abs_path, 24)
    } else {
        None
    };

    let mut meta = json!({
        "id": id,
        "title": base_title,
        "kind": kind,
        "mode": normalized_mode,
        "mime": mime,
        "ext": ext,
        "size": size,
        "sourcePath": abs_display,
        "storedPath": stored_path,
        "sha256": Value::Null,
        "preview": preview,
        "createdAt": now,
        "updatedAt": now,
    });
    if let Some(count) = entry_count {
        meta["entryCount"] = count;
    }
    let meta = file_meta::normalize_file_meta(&meta, source_id.as_deref());
    write_meta_file(&root_path, &meta)?;
    upsert_index_entry(&root_path, &meta)?;
    resource_from_meta(&root_path, &meta).ok_or_else(|| "写入文件资源后读取失败".to_string())
}

#[tauri::command]
pub(crate) fn native_path_exists(path: String) -> bool {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return false;
    }
    if crate::saf::is_content_uri(trimmed) {
        return crate::saf::uri_exists(trimmed);
    }
    PathBuf::from(trimmed).exists()
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
pub(crate) fn load_workspace(app: AppHandle) -> Result<WorkspaceSnapshot, String> {
    load_file_workspace(&app_data_dir(&app)?, "tie-workspace")
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
    load_file_workspace(&app_data_dir(&app)?, "tie-workspace")
}

#[tauri::command]
pub(crate) fn save_page(
    app: AppHandle,
    page: Page,
    expected_updated_at: Option<String>,
    write_source_id: Option<String>,
) -> Result<Page, String> {
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
    let (sources, _) = workspace_sources(&app)?;
    io::list_file_page_assets(&page, &sources)
}

#[tauri::command]
pub(crate) fn list_page_revisions(
    app: AppHandle,
    page_id: String,
    storage_source_id: String,
) -> Result<Vec<PageRevision>, String> {
    let (sources, _) = workspace_sources(&app)?;
    io::list_page_revisions(&sources, &page_id, &storage_source_id)
}

#[tauri::command]
pub(crate) fn read_page_revision(
    app: AppHandle,
    page: Page,
    revision_id: String,
) -> Result<Page, String> {
    let (sources, _) = workspace_sources(&app)?;
    io::read_page_revision(&sources, &page, &revision_id)
}

#[tauri::command]
pub(crate) fn restore_page_revision(
    app: AppHandle,
    page: Page,
    revision_id: String,
) -> Result<Page, String> {
    let (sources, _) = workspace_sources(&app)?;
    io::restore_page_revision(&sources, page, &revision_id)
}

#[tauri::command]
pub(crate) fn export_page_markdown(page: Page, target_path: String) -> Result<(), String> {
    io::export_page_markdown(&page, &target_path)
}

#[tauri::command]
pub(crate) fn permanently_delete_pages(app: AppHandle, pages: Vec<Page>) -> Result<(), String> {
    let (sources, _) = workspace_sources(&app)?;
    io::permanently_delete_pages(&sources, &pages)
}

#[tauri::command]
pub(crate) fn remove_storage_source(
    app: AppHandle,
    source_id: String,
) -> Result<WorkspaceSnapshot, String> {
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
    load_file_workspace(&app_data_dir(&app)?, "tie-workspace")
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
    load_file_workspace(&app_data_dir(&app)?, "tie-workspace")
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
    load_file_workspace(&app_data_dir(&app)?, "tie-workspace")
}

#[tauri::command]
pub(crate) fn save_file_page_asset(
    app: AppHandle,
    page: Page,
    file_name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    let (sources, _) = workspace_sources(&app)?;
    io::save_file_page_asset(&sources, &page, &file_name, &data)
}

#[tauri::command]
pub(crate) fn read_file_page_asset(
    app: AppHandle,
    page: Page,
    asset_name: String,
) -> Result<Vec<u8>, String> {
    let (sources, _) = workspace_sources(&app)?;
    io::read_file_page_asset(&sources, &page, &asset_name)
}
