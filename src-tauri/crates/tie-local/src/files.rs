//! Local file registry under `.tie/files/` (list / get / link|copy ingest).

use crate::links::{build_file_url, build_path_url};
use crate::page::new_page_id;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tie_common::file_meta::{normalize_file_meta, source_path_from_meta};

const MAX_COPY_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_COPY_DIR_BYTES: u64 = 50 * 1024 * 1024;
const MAX_COPY_DIR_FILES: usize = 200;
const MAX_COPY_DIR_DEPTH: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexEntry {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub kind: String,
    pub mode: String,
    #[serde(default)]
    pub ext: String,
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOpenHint {
    pub file_id: String,
    pub title: String,
    pub open_path: String,
    pub exists: bool,
    pub mode: String,
    pub kind: String,
    pub url: String,
    pub hint: String,
}

fn mtime_iso(meta: &fs::Metadata) -> Option<String> {
    let modified = meta.modified().ok()?;
    let millis = modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    Some(crate::api::format_utc_millis_pub(millis))
}

fn is_text_ext(ext: &str) -> bool {
    matches!(
        ext,
        "txt"
            | "md"
            | "markdown"
            | "json"
            | "csv"
            | "tsv"
            | "log"
            | "yml"
            | "yaml"
            | "toml"
            | "xml"
            | "html"
            | "htm"
            | "css"
            | "js"
            | "ts"
            | "tsx"
            | "jsx"
            | "rs"
            | "py"
            | "go"
    )
}

fn read_text_preview(path: &Path, ext: &str, max_chars: usize) -> Option<String> {
    if !is_text_ext(ext) {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    let cleaned: String = raw.chars().filter(|c| *c != '\0').take(max_chars).collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn directory_preview(path: &Path, max_entries: usize) -> Option<String> {
    let mut names = Vec::new();
    let mut truncated = false;
    let entries = fs::read_dir(path).ok()?;
    for entry in entries.flatten() {
        if names.len() >= max_entries {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        names.push(if is_dir { format!("{name}/") } else { name });
    }
    if names.is_empty() {
        return Some("(空目录)".to_owned());
    }
    let mut text = names.join("\n");
    if truncated {
        text.push_str("\n…");
    }
    Some(text)
}

fn files_root(workspace: &Path) -> PathBuf {
    workspace.join(".tie").join("files")
}

fn index_path(workspace: &Path) -> PathBuf {
    files_root(workspace).join("index.json")
}

fn meta_path(workspace: &Path, file_id: &str) -> PathBuf {
    files_root(workspace).join(file_id).join("meta.json")
}

fn now_iso() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    crate::api::format_utc_millis_pub(millis)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn guess_mime(ext: &str, is_dir: bool) -> &'static str {
    if is_dir {
        return "inode/directory";
    }
    match ext {
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
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
}

fn sanitize_stored_name(ext: &str) -> String {
    let clean: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    if clean.is_empty() {
        "original.bin".to_owned()
    } else {
        format!("original.{clean}")
    }
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => a.to_string_lossy().replace('\\', "/") == b.to_string_lossy().replace('\\', "/"),
    }
}

#[derive(Default)]
struct DirStats {
    size: u64,
    files: usize,
    dirs: usize,
}

fn walk_dir_stats(path: &Path, depth: usize, stats: &mut DirStats) -> Result<(), String> {
    if depth > MAX_COPY_DIR_DEPTH {
        return Err(format!(
            "导入目录不能超过 {MAX_COPY_DIR_DEPTH} 层，请改用登记或缩小范围"
        ));
    }
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let full = entry.path();
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            stats.dirs += 1;
            walk_dir_stats(&full, depth + 1, stats)?;
        } else if ft.is_file() {
            stats.files += 1;
            stats.size += fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
        }
        if stats.files > MAX_COPY_DIR_FILES {
            return Err(format!(
                "导入目录不能超过 {MAX_COPY_DIR_FILES} 个文件，请改用登记或缩小范围"
            ));
        }
        if stats.size > MAX_COPY_DIR_BYTES {
            return Err("导入目录不能超过 50 MB，请改用登记或缩小范围".to_owned());
        }
    }
    Ok(())
}

fn assert_copy_limits(path: &Path, is_dir: bool, size: u64) -> Result<(), String> {
    if !is_dir {
        if size > MAX_COPY_FILE_BYTES {
            return Err("导入文件不能超过 50 MB，请改用登记（绝对链接）".to_owned());
        }
        return Ok(());
    }
    let mut stats = DirStats::default();
    walk_dir_stats(path, 1, &mut stats)?;
    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ft.is_file() {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn relative_to_workspace(workspace: &Path, path: &Path) -> String {
    path.strip_prefix(workspace)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

fn find_existing(
    workspace: &Path,
    abs: &Path,
    mode: &str,
    sha256: Option<&str>,
) -> Option<Value> {
    for entry in read_index(workspace) {
        let Some(meta) = read_meta(workspace, &entry.id) else {
            continue;
        };
        if meta.get("mode").and_then(Value::as_str) != Some(mode) {
            continue;
        }
        if let (Some(want), Some(have)) = (
            sha256,
            meta.get("sha256")
                .or_else(|| meta.get("contentHash"))
                .and_then(Value::as_str),
        ) {
            if !have.is_empty() && have == want {
                return Some(meta);
            }
        }
        let locator = source_path_from_meta(&meta);
        if !locator.is_empty() && paths_equal(Path::new(&locator), abs) {
            return Some(meta);
        }
        if mode == "link" {
            let stored = meta.get("storedPath").and_then(Value::as_str).unwrap_or("");
            if !stored.is_empty() && paths_equal(Path::new(stored), abs) {
                return Some(meta);
            }
        }
    }
    None
}

fn enrich_result(meta: Value, source_id: &str, created: bool) -> Value {
    let mut enriched = normalize_file_meta(&meta, Some(source_id));
    if let Value::Object(map) = &mut enriched {
        map.insert("url".into(), json!(resource_url(&meta, source_id)));
        map.insert("created".into(), json!(created));
    }
    enriched
}

fn new_file_id() -> String {
    format!("file_{}", &new_page_id()[3..])
}

fn read_index(workspace: &Path) -> Vec<FileIndexEntry> {
    let path = index_path(workspace);
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<FileIndexEntry>>(&raw).unwrap_or_default()
}

fn write_index(workspace: &Path, entries: &[FileIndexEntry]) -> Result<(), String> {
    let root = files_root(workspace);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    fs::write(index_path(workspace), format!("{raw}\n")).map_err(|e| e.to_string())
}

fn read_meta(workspace: &Path, file_id: &str) -> Option<Value> {
    let path = meta_path(workspace, file_id);
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_meta(workspace: &Path, meta: &Value) -> Result<(), String> {
    let id = meta
        .get("id")
        .and_then(Value::as_str)
        .ok_or("文件 meta 缺少 id")?;
    let dir = files_root(workspace).join(id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(meta_path(workspace, id), format!("{raw}\n")).map_err(|e| e.to_string())
}

fn upsert_index(workspace: &Path, meta: &Value) -> Result<(), String> {
    let id = meta.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
    let mut entries: Vec<FileIndexEntry> = read_index(workspace)
        .into_iter()
        .filter(|item| item.id != id)
        .collect();
    entries.insert(
        0,
        FileIndexEntry {
            id,
            title: meta
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            kind: meta
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("file")
                .to_owned(),
            mode: meta
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("link")
                .to_owned(),
            ext: meta
                .get("ext")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            mime: meta
                .get("mime")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream")
                .to_owned(),
            size: meta.get("size").and_then(Value::as_u64).unwrap_or(0),
            updated_at: meta
                .get("updatedAt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        },
    );
    write_index(workspace, &entries)
}

fn resource_url(meta: &Value, source_id: &str) -> String {
    let id = meta.get("id").and_then(Value::as_str).unwrap_or("");
    let mode = meta.get("mode").and_then(Value::as_str).unwrap_or("link");
    if mode == "copy" {
        let stored = meta.get("storedPath").and_then(Value::as_str).unwrap_or("");
        if !stored.is_empty() {
            return build_path_url(stored, source_id);
        }
    }
    build_file_url(id, source_id)
}

fn open_path_for(workspace: &Path, meta: &Value) -> String {
    let mode = meta.get("mode").and_then(Value::as_str).unwrap_or("link");
    if mode == "copy" {
        let stored = meta.get("storedPath").and_then(Value::as_str).unwrap_or("");
        if Path::new(stored).is_absolute() {
            return stored.to_owned();
        }
        return workspace.join(stored).to_string_lossy().into_owned();
    }
    let source = source_path_from_meta(meta);
    if !source.is_empty() {
        return source;
    }
    meta.get("storedPath")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

pub struct FileRegistry<'a> {
    workspace: &'a Path,
    source_id: String,
}

impl<'a> FileRegistry<'a> {
    pub fn new(workspace: &'a Path, source_id: Option<&str>) -> Self {
        Self {
            workspace,
            source_id: source_id.unwrap_or("").trim().to_owned(),
        }
    }

    pub fn all_metadata(&self) -> Vec<Value> {
        read_index(self.workspace)
            .into_iter()
            .filter_map(|entry| read_meta(self.workspace, &entry.id))
            .collect()
    }

    pub fn upsert_metadata(&self, meta: &Value) -> Result<(), String> {
        let id = meta.get("id").and_then(Value::as_str).unwrap_or("");
        if !id.starts_with("file_") || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
            return Err("文件资源 id 无效".to_owned());
        }
        write_meta(self.workspace, meta)?;
        upsert_index(self.workspace, meta)
    }

    pub fn list(
        &self,
        query: Option<&str>,
        ext: Option<&str>,
        limit: usize,
    ) -> Result<Vec<Value>, String> {
        let q = query.map(str::trim).filter(|s| !s.is_empty()).map(|s| s.to_lowercase());
        let ext_filter = ext
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_start_matches('.').to_lowercase());
        let limit = limit.clamp(1, 200);
        let mut out = Vec::new();
        for entry in read_index(self.workspace) {
            if let Some(ext) = &ext_filter {
                if entry.ext.to_lowercase() != *ext {
                    continue;
                }
            }
            let Some(meta) = read_meta(self.workspace, &entry.id) else {
                continue;
            };
            if let Some(q) = &q {
                let hay = format!(
                    "{} {} {} {}",
                    entry.title,
                    entry.id,
                    entry.ext,
                    source_path_from_meta(&meta)
                )
                .to_lowercase();
                if !hay.contains(q) {
                    continue;
                }
            }
            let mut enriched = normalize_file_meta(&meta, Some(self.source_id.as_str()));
            if let Value::Object(map) = &mut enriched {
                map.insert("url".into(), json!(resource_url(&meta, &self.source_id)));
            }
            out.push(enriched);
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }

    pub fn get(&self, file_id: &str) -> Result<Option<Value>, String> {
        let Some(meta) = read_meta(self.workspace, file_id) else {
            return Ok(None);
        };
        let mut enriched = normalize_file_meta(&meta, Some(self.source_id.as_str()));
        if let Value::Object(map) = &mut enriched {
            map.insert("url".into(), json!(resource_url(&meta, &self.source_id)));
        }
        Ok(Some(enriched))
    }

    pub fn open_hint(&self, file_id: &str) -> Result<FileOpenHint, String> {
        let meta = read_meta(self.workspace, file_id)
            .ok_or_else(|| format!("文件资源不存在：{file_id}"))?;
        let open_path = open_path_for(self.workspace, &meta);
        let exists = Path::new(&open_path).exists();
        let mode = meta
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("link")
            .to_owned();
        let kind = meta
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("file")
            .to_owned();
        let is_directory = kind == "directory"
            || Path::new(&open_path)
                .metadata()
                .map(|m| m.is_dir())
                .unwrap_or(false);
        let hint = if exists {
            if is_directory {
                format!("可用系统文件管理器打开目录：{open_path}")
            } else {
                format!("可用系统默认应用打开：{open_path}")
            }
        } else if mode == "link" {
            format!("路径不可用（找不到已登记文件）：{open_path}")
        } else {
            format!("路径不可用（副本缺失）：{open_path}")
        };
        Ok(FileOpenHint {
            file_id: file_id.to_owned(),
            title: meta
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or(file_id)
                .to_owned(),
            open_path,
            exists,
            mode,
            kind,
            url: resource_url(&meta, &self.source_id),
            hint,
        })
    }

    pub fn ingest_link(&self, path: &Path, title: Option<&str>) -> Result<Value, String> {
        self.ingest("link", path, title)
    }

    /// Register a path as `link` (absolute) or `copy` (workspace-relative under `.tie/files/`).
    pub fn ingest(&self, mode: &str, path: &Path, title: Option<&str>) -> Result<Value, String> {
        let mode = match mode {
            "copy" | "link" => mode,
            _ => return Err("mode 必须是 copy 或 link".to_owned()),
        };
        let abs = path
            .canonicalize()
            .map_err(|e| format!("无法访问路径：{e}"))?;
        if !abs.exists() {
            return Err(format!("路径不存在：{}", abs.display()));
        }
        let meta_fs = fs::metadata(&abs).map_err(|e| e.to_string())?;
        let is_dir = meta_fs.is_dir();
        if !is_dir && !meta_fs.is_file() {
            return Err(format!("不是普通文件或目录：{}", abs.display()));
        }
        let file_name = abs
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(if is_dir { "directory" } else { "file" });
        let ext = if is_dir {
            "dir".to_owned()
        } else {
            abs.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase()
        };
        let mime = guess_mime(&ext, is_dir);
        let sha256 = if !is_dir && mode == "copy" {
            Some(sha256_file(&abs)?)
        } else {
            None
        };

        let mut dir_stats = DirStats::default();
        if is_dir && mode == "copy" {
            walk_dir_stats(&abs, 1, &mut dir_stats)?;
        }
        if mode == "copy" {
            let size = if is_dir { dir_stats.size } else { meta_fs.len() };
            assert_copy_limits(&abs, is_dir, size)?;
        }

        if let Some(existing) = find_existing(self.workspace, &abs, mode, sha256.as_deref()) {
            return Ok(enrich_result(existing, &self.source_id, false));
        }

        let id = new_file_id();
        let stamp = now_iso();
        let abs_str = abs.to_string_lossy().into_owned();
        let mut stored_path = abs_str.clone();
        if mode == "copy" {
            let dir = files_root(self.workspace).join(&id);
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            if is_dir {
                let target = dir.join("original");
                copy_dir_recursive(&abs, &target)?;
                stored_path = relative_to_workspace(self.workspace, &target);
            } else {
                let target = dir.join(sanitize_stored_name(&ext));
                fs::copy(&abs, &target).map_err(|e| e.to_string())?;
                stored_path = relative_to_workspace(self.workspace, &target);
            }
        }

        let size = if is_dir {
            dir_stats.size
        } else {
            meta_fs.len()
        };
        let preview = if is_dir {
            // link 大目录不做 preview，避免卡住；copy 已扫过树
            if mode == "copy" {
                directory_preview(&abs, 24)
            } else {
                None
            }
        } else {
            read_text_preview(&abs, &ext, 1200)
        };
        let mut raw = json!({
            "id": id,
            "title": title.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(file_name),
            "kind": if is_dir { "directory" } else { "file" },
            "mode": mode,
            "mime": mime,
            "ext": ext,
            "size": size,
            "sourcePath": abs_str,
            "storedPath": stored_path,
            "createdAt": stamp,
            "updatedAt": stamp,
        });
        if let Some(mtime) = mtime_iso(&meta_fs) {
            raw["mtime"] = json!(mtime);
        }
        if let Some(preview) = preview {
            raw["preview"] = json!(preview);
        }
        if let Some(hash) = sha256 {
            raw["sha256"] = json!(hash);
            raw["contentHash"] = json!(hash);
        }
        if is_dir && mode == "copy" {
            raw["entryCount"] = json!({
                "files": dir_stats.files,
                "dirs": dir_stats.dirs,
            });
        }
        let meta = normalize_file_meta(&raw, Some(self.source_id.as_str()));
        write_meta(self.workspace, &meta)?;
        upsert_index(self.workspace, &meta)?;
        Ok(enrich_result(meta, &self.source_id, true))
    }
}

impl crate::api::LocalWorkspace {
    pub fn files(&self) -> FileRegistry<'_> {
        FileRegistry::new(self.root(), Some(self.default_source_id()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn link_ingest_list_get() {
        let dir = env::temp_dir().join(format!("tie-files-{}", new_file_id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("pages")).unwrap();
        let sample = dir.join("sample.txt");
        fs::write(&sample, b"hello").unwrap();
        let reg = FileRegistry::new(&dir, Some("src_local_0123456789abcdef"));
        let meta = reg.ingest_link(&sample, Some("样例")).unwrap();
        assert_eq!(meta.get("created"), Some(&json!(true)));
        let id = meta.get("id").and_then(Value::as_str).unwrap();
        let listed = reg.list(Some("样例"), None, 10).unwrap();
        assert_eq!(listed.len(), 1);
        let got = reg.get(id).unwrap().expect("get");
        assert_eq!(got.get("title").and_then(Value::as_str), Some("样例"));
        let hint = reg.open_hint(id).unwrap();
        assert!(hint.exists);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_ingest_stores_relative_path() {
        let dir = env::temp_dir().join(format!("tie-files-copy-{}", new_file_id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("pages")).unwrap();
        let sample = dir.join("note.md");
        fs::write(&sample, b"# hi\n").unwrap();
        let reg = FileRegistry::new(&dir, Some("src_local_0123456789abcdef"));
        let meta = reg.ingest("copy", &sample, Some("副本")).unwrap();
        assert_eq!(meta.get("created"), Some(&json!(true)));
        assert_eq!(meta.get("mode").and_then(Value::as_str), Some("copy"));
        let stored = meta.get("storedPath").and_then(Value::as_str).unwrap();
        assert!(stored.starts_with(".tie/files/"));
        assert!(dir.join(stored).is_file());
        let url = meta.get("url").and_then(Value::as_str).unwrap();
        assert!(url.starts_with("tie://path/"));
        assert!(meta.get("preview").and_then(Value::as_str).is_some());
        assert!(meta.get("mtime").and_then(Value::as_str).is_some());
        let again = reg.ingest("copy", &sample, None).unwrap();
        assert_eq!(again.get("created"), Some(&json!(false)));
        let id = meta.get("id").and_then(Value::as_str).unwrap();
        let hint = reg.open_hint(id).unwrap();
        assert!(hint.exists);
        assert!(hint.hint.contains("打开"));
        let _ = fs::remove_dir_all(&dir);
    }
}
