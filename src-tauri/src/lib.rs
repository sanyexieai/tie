use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use keyring::Entry;
use futures_util::StreamExt;
use minio::s3::{builders::ObjectContent, creds::StaticProvider, response::BucketExistsResponse, types::{BucketName, S3Api, ToStream}, MinioClient, MinioClientBuilder};
use tauri::Manager;

mod ai_cli;
mod codex_mcp;
mod skills;

const S3_CREDENTIAL_SERVICE: &str = "com.tie.knowledge.s3";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct S3Credentials {
    access_key: String,
    secret_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct S3Connection {
    provider_id: String,
    endpoint: String,
    bucket: String,
    region: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct S3PageIndexEntry {
    page_id: String,
    etag: Option<String>,
    last_modified: Option<String>,
}

fn is_minio_like_endpoint(endpoint: &str) -> bool {
    let lower = endpoint.to_ascii_lowercase();
    !lower.contains("amazonaws.com") && !lower.contains("cloudflarestorage.com")
}

fn s3_credential_entry(provider_id: &str) -> Result<Entry, String> {
    if provider_id.trim().is_empty() {
        return Err("S3 配置标识不能为空".to_owned());
    }
    Entry::new(S3_CREDENTIAL_SERVICE, provider_id).map_err(|error| error.to_string())
}

fn s3_client(connection: &S3Connection) -> Result<(MinioClient, BucketName), String> {
    let raw_credentials = s3_credential_entry(&connection.provider_id)?
        .get_password()
        .map_err(|_| "未找到此 S3 连接的本机密钥，请重新保存配置".to_owned())?;
    let credentials: S3Credentials = serde_json::from_str(&raw_credentials)
        .map_err(|_| "本机 S3 密钥无效，请重新保存配置".to_owned())?;
    let endpoint = connection.endpoint.trim().parse()
        .map_err(|error| format!("Endpoint 格式无效：{error}"))?;
    let bucket = BucketName::new(connection.bucket.trim()).map_err(|error| format!("Bucket 名称无效：{error}"))?;
    let skip_region_lookup = is_minio_like_endpoint(connection.endpoint.trim())
        || connection.region.is_some();
    let client = MinioClientBuilder::new(endpoint)
        .skip_region_lookup(skip_region_lookup)
        .provider(Some(StaticProvider::new(&credentials.access_key, &credentials.secret_key, None)))
        .build()
        .map_err(|error| format!("无法创建 S3 客户端：{error}"))?;
    Ok((client, bucket))
}

fn s3_page_id_from_key(name: &str) -> Option<String> {
    name.strip_prefix("tie/pages/")?.strip_suffix(".md").map(str::to_owned)
}

async fn list_s3_object_index(connection: &S3Connection) -> Result<Vec<S3PageIndexEntry>, String> {
    let (client, bucket) = s3_client(connection)?;
    let mut stream = client.list_objects(bucket.clone())
        .map_err(|error| format!("无法列出 S3 页面：{error}"))?
        .prefix(Some("tie/pages/".to_owned()))
        .recursive(true)
        .build()
        .to_stream()
        .await;
    let mut entries = Vec::new();
    while let Some(batch) = stream.next().await {
        let batch = batch.map_err(|error| format!("无法读取 S3 页面列表：{error}"))?;
        for entry in batch.contents.into_iter().filter(|entry| entry.name.ends_with(".md")) {
            let Some(page_id) = s3_page_id_from_key(&entry.name) else { continue };
            entries.push(S3PageIndexEntry {
                page_id,
                etag: entry.etag.clone(),
                last_modified: entry.last_modified.map(|value| value.to_rfc3339()),
            });
        }
    }
    Ok(entries)
}

async fn download_s3_page(
    client: &MinioClient,
    bucket: BucketName,
    source_id: &str,
    object_name: String,
) -> Result<Page, String> {
    let response = client.get_object(bucket, object_name)
        .map_err(|error| format!("无法读取 S3 页面：{error}"))?
        .build()
        .send()
        .await
        .map_err(|error| format!("无法下载 S3 页面：{error}"))?;
    let content = String::from_utf8(response.into_bytes().await.map_err(|error| format!("无法读取 S3 页面内容：{error}"))?.to_vec())
        .map_err(|_| "S3 页面不是 UTF-8 Markdown 文件".to_owned())?;
    let mut page = parse_page(&content).map_err(|error| format!("S3 页面格式无效：{error}"))?;
    page.storage_source_id = source_id.to_owned();
    Ok(page)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    id: String,
    name: String,
    sources: Vec<StorageSource>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageSource {
    id: String,
    name: String,
    kind: String,
    path: String,
    #[serde(default = "default_source_available")]
    available: bool,
}

fn default_source_available() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    id: String,
    title: String,
    #[serde(default)]
    icon: String,
    parent_id: Option<String>,
    sort_key: i64,
    markdown: String,
    tags: Vec<String>,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    #[serde(default)]
    storage_source_id: String,
    #[serde(default)]
    storage_source_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSnapshot {
    workspace: Workspace,
    pages: Vec<Page>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageRevision {
    id: String,
    saved_at: String,
    title: String,
}

const MAX_PAGE_REVISIONS: usize = 80;

#[derive(Deserialize, Serialize)]
struct WorkspaceSettings {
    #[serde(default)]
    name: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    sources: Vec<StorageSource>,
    #[serde(default, rename = "s3Providers")]
    s3_providers: Vec<S3ProviderConfig>,
}

fn default_created_at() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_owned())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct S3ProviderConfig {
    id: String,
    name: String,
    endpoint: String,
    bucket: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    region: Option<String>,
    #[serde(default)]
    credential_stored: bool,
    #[serde(default = "default_created_at")]
    created_at: String,
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn load_settings(app: &tauri::AppHandle) -> Result<WorkspaceSettings, String> {
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

fn save_settings(app: &tauri::AppHandle, settings: &WorkspaceSettings) -> Result<(), String> {
    let content = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(app_data_dir(app)?.join("workspace.json"), content).map_err(|error| error.to_string())
}

fn source_id(path: &Path, kind: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    kind.hash(&mut hasher);
    format!("src_{kind}_{:016x}", hasher.finish())
}

fn source_from_path(path: PathBuf, kind: String) -> StorageSource {
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

fn workspace_sources(app: &tauri::AppHandle) -> Result<(Vec<StorageSource>, bool), String> {
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

fn markdown_path(root: &Path, page_id: &str) -> PathBuf {
    root.join("pages").join(format!("{page_id}.md"))
}

fn revision_dir(root: &Path, page_id: &str) -> PathBuf {
    root.join(".tie").join("history").join(page_id)
}

fn page_asset_dir(root: &Path, page_id: &str) -> PathBuf {
    root.join(".tie").join("assets").join(page_id)
}

fn sanitize_asset_name(file_name: &str) -> Result<String, String> {
    let base = Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("附件名称无效")?;
    if base.is_empty()
        || base == "."
        || base == ".."
        || !base
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '.' || character == '-' || character == '_')
    {
        return Err("附件名称无效".to_owned());
    }
    Ok(base.to_owned())
}

#[tauri::command]
fn list_file_page_assets(app: tauri::AppHandle, page: Page) -> Result<Vec<String>, String> {
    let root = source_root(&app, &page.storage_source_id)?;
    let directory = page_asset_dir(&root, &page.id);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_file() {
            if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
                names.push(name.to_owned());
            }
        }
    }
    Ok(names)
}

fn source_root(app: &tauri::AppHandle, storage_source_id: &str) -> Result<PathBuf, String> {
    let (sources, _) = workspace_sources(app)?;
    let source = sources
        .iter()
        .find(|item| item.id == storage_source_id)
        .ok_or("页面所属存储源不存在")?;
    Ok(PathBuf::from(&source.path))
}

fn revision_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos}")
}

fn page_has_changed(before: &Page, after: &Page) -> bool {
    before.title != after.title
        || before.icon != after.icon
        || before.parent_id != after.parent_id
        || before.sort_key != after.sort_key
        || before.markdown != after.markdown
        || before.tags != after.tags
        || before.deleted_at != after.deleted_at
}

fn archive_page_revision(root: &Path, page: &Page) -> Result<(), String> {
    let directory = revision_dir(root, &page.id);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::write(
        directory.join(format!("{}.md", revision_id())),
        frontmatter(page),
    )
    .map_err(|error| error.to_string())?;
    let mut revisions = fs::read_dir(&directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "md"))
        .collect::<Vec<_>>();
    revisions.sort();
    while revisions.len() > MAX_PAGE_REVISIONS {
        let oldest = revisions.remove(0);
        fs::remove_file(oldest).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn copy_page_assets(source_root: &Path, target_root: &Path, page_id: &str) -> Result<(), String> {
    let source_directory = page_asset_dir(source_root, page_id);
    if !source_directory.exists() {
        return Ok(());
    }
    let target_directory = page_asset_dir(target_root, page_id);
    fs::create_dir_all(&target_directory).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(&source_directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_file() {
            if let Err(error) = fs::copy(&path, target_directory.join(entry.file_name())) {
                return Err(format!("无法迁移页面附件：{error}"));
            }
        }
    }
    Ok(())
}

fn remove_page_assets(root: &Path, page_id: &str) -> Result<(), String> {
    let directory = page_asset_dir(root, page_id);
    if directory.exists() {
        fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn copy_page_history(source_root: &Path, target_root: &Path, page_id: &str) -> Result<(), String> {
    let source_directory = revision_dir(source_root, page_id);
    if !source_directory.exists() {
        return Ok(());
    }
    let target_directory = revision_dir(target_root, page_id);
    if target_directory.exists() {
        return Err("目标存储源中已存在该页面的历史记录，无法迁移".to_owned());
    }
    fs::create_dir_all(&target_directory).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(&source_directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_file() {
            if let Err(error) = fs::copy(&path, target_directory.join(entry.file_name())) {
                let _ = fs::remove_dir_all(&target_directory);
                return Err(format!("无法迁移页面历史：{error}"));
            }
        }
    }
    Ok(())
}

fn frontmatter(page: &Page) -> String {
    let page = normalize_page_sources(page.clone());
    let parent = page.parent_id.clone().unwrap_or_default();
    let tags = page.tags.join(", ");
    let deleted = page
        .deleted_at
        .as_ref()
        .map(|value| format!("deleted_at: {value}\n"))
        .unwrap_or_default();
    let icon = page.icon.replace(['\n', '\r'], "");
    let extra_sources = source_ids_frontmatter(&page);
    format!("---\ntie_version: 1\nid: {}\nstorage_source_id: {}\n{}parent_id: {}\nsort_key: {}\nicon: {}\ntags: [{}]\ncreated_at: {}\nupdated_at: {}\n{}---\n\n{}", page.id, page.storage_source_id, extra_sources, parent, page.sort_key, icon, tags, page.created_at, page.updated_at, deleted, page.markdown)
}


fn parse_source_ids(raw: &str) -> Vec<String> {
    raw.trim_matches(['[', ']'])
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect()
}


fn merge_loaded_pages(pages: Vec<Page>) -> Vec<Page> {
    let mut map: HashMap<String, Page> = HashMap::new();
    for page in pages {
        let page = normalize_page_sources(page);
        match map.remove(&page.id) {
            None => {
                map.insert(page.id.clone(), page);
            }
            Some(existing) => {
                let mut ids = existing.storage_source_ids.clone();
                for id in &page.storage_source_ids {
                    if !ids.iter().any(|item| item == id) {
                        ids.push(id.clone());
                    }
                }
                let newer = if existing.updated_at >= page.updated_at {
                    existing
                } else {
                    page
                };
                let primary = if ids.iter().any(|id| id == &newer.storage_source_id) {
                    newer.storage_source_id.clone()
                } else {
                    ids.first().cloned().unwrap_or_default()
                };
                map.insert(
                    newer.id.clone(),
                    normalize_page_sources(Page {
                        storage_source_id: primary,
                        storage_source_ids: ids,
                        ..newer
                    }),
                );
            }
        }
    }
    map.into_values().collect()
}

fn normalize_page_sources(mut page: Page) -> Page {
    if page.storage_source_ids.is_empty() {
        if !page.storage_source_id.is_empty() {
            page.storage_source_ids = vec![page.storage_source_id.clone()];
        }
    } else if !page.storage_source_id.is_empty()
        && !page.storage_source_ids.iter().any(|id| id == &page.storage_source_id)
    {
        page.storage_source_ids.insert(0, page.storage_source_id.clone());
    } else if page.storage_source_id.is_empty() {
        if let Some(first) = page.storage_source_ids.first().cloned() {
            page.storage_source_id = first;
        }
    }
    page
}

fn source_ids_frontmatter(page: &Page) -> String {
    if page.storage_source_ids.len() <= 1 {
        String::new()
    } else {
        format!(
            "storage_source_ids: [{}]\n",
            page.storage_source_ids.join(", ")
        )
    }
}

fn value(lines: &[&str], key: &str) -> String {
    lines
        .iter()
        .find_map(|line| line.strip_prefix(&format!("{key}: ")).map(str::to_owned))
        .unwrap_or_default()
}

fn parse_page(content: &str) -> Result<Page, String> {
    let (_, rest) = content
        .split_once("---\n")
        .ok_or("缺少 Frontmatter 起始标记")?;
    let (meta, markdown) = rest
        .split_once("---\n")
        .ok_or("缺少 Frontmatter 结束标记")?;
    let lines: Vec<&str> = meta.lines().collect();
    let id = value(&lines, "id");
    if id.is_empty() {
        return Err("页面缺少 id".to_owned());
    }
    let tags = value(&lines, "tags")
        .trim_matches(['[', ']'])
        .split(',')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(str::to_owned)
        .collect();
    let markdown = markdown.trim_start_matches('\n').to_owned();
    let title = markdown
        .lines()
        .find_map(|line| line.strip_prefix("# "))
        .unwrap_or("无标题")
        .to_owned();
    let parent_id = value(&lines, "parent_id");
    Ok(normalize_page_sources(Page {
        id,
        title,
        icon: value(&lines, "icon"),
        parent_id: (!parent_id.is_empty()).then_some(parent_id),
        sort_key: value(&lines, "sort_key").parse().unwrap_or(0),
        markdown,
        tags,
        created_at: value(&lines, "created_at"),
        updated_at: value(&lines, "updated_at"),
        deleted_at: (!value(&lines, "deleted_at").is_empty()).then(|| value(&lines, "deleted_at")),
        storage_source_id: value(&lines, "storage_source_id"),
        storage_source_ids: parse_source_ids(&value(&lines, "storage_source_ids")),
    }))
}

fn demo_pages(storage_source_id: &str) -> Vec<Page> {
    let created = "2026-08-27T00:00:00.000Z".to_owned();
    vec![
    Page { id: "pg_inbox".into(), title: "收集箱".into(), icon: "📥".into(), parent_id: None, sort_key: 0, markdown: "# 收集箱\n\n把想法先放在这里，再慢慢整理。\n\n- 在页面内创建子页面\n- 直接用 Markdown 写作\n- 后续可通过链接、标签和图谱建立关联\n".into(), tags: vec!["收集".into()], created_at: created.clone(), updated_at: created.clone(), deleted_at: None, storage_source_id: storage_source_id.to_owned(), storage_source_ids: vec![storage_source_id.to_owned()] },
    Page { id: "pg_welcome".into(), title: "欢迎使用 Tie".into(), icon: "👋".into(), parent_id: Some("pg_inbox".into()), sort_key: 0, markdown: "# 欢迎使用 Tie\n\nTie 把 **Notion 的页面树**、**Typora 的写作感** 和 **Obsidian 的链接关系** 放在一起。\n\n## 从这里开始\n\n1. 在左侧创建页面或子页面\n2. 直接用 Markdown 写作\n3. 用标签与链接整理知识\n".into(), tags: vec!["开始".into()], created_at: created.clone(), updated_at: created, deleted_at: None, storage_source_id: storage_source_id.to_owned(), storage_source_ids: vec![storage_source_id.to_owned()] },
  ]
}

fn ensure_demo(root: &Path, storage_source_id: &str) -> Result<(), String> {
    if fs::read_dir(root.join("pages"))
        .map_err(|error| error.to_string())?
        .next()
        .is_none()
    {
        for page in demo_pages(storage_source_id) {
            fs::write(markdown_path(root, &page.id), frontmatter(&page))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn load_workspace(app: tauri::AppHandle) -> Result<WorkspaceSnapshot, String> {
    let workspace_name = load_settings(&app)?.name;
    let (mut sources, is_default_source) = workspace_sources(&app)?;
    if is_default_source {
        let root = PathBuf::from(&sources[0].path);
        fs::create_dir_all(root.join("pages")).map_err(|error| error.to_string())?;
        ensure_demo(&root, &sources[0].id)?;
    }
    let mut pages = Vec::new();
    for source in &mut sources {
        let root = PathBuf::from(&source.path);
        let pages_dir = root.join("pages");
        if fs::create_dir_all(&pages_dir).is_err() {
            source.available = false;
            continue;
        }
        source.available = true;
        for entry in fs::read_dir(pages_dir).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            if path.extension().is_some_and(|extension| extension == "md") {
                let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
                let mut page =
                    parse_page(&content).map_err(|error| format!("{}: {error}", path.display()))?;
                if page.storage_source_id.is_empty() {
                    page.storage_source_id = source.id.clone();
                }
                if !page
                    .storage_source_ids
                    .iter()
                    .any(|id| id == &source.id)
                {
                    page.storage_source_ids.push(source.id.clone());
                }
                pages.push(normalize_page_sources(page));
            }
        }
    }
    Ok(WorkspaceSnapshot {
        workspace: Workspace {
            id: "tie-workspace".to_owned(),
            name: if workspace_name.trim().is_empty() {
                "我的知识库".to_owned()
            } else {
                workspace_name
            },
            sources,
        },
        pages: merge_loaded_pages(pages),
    })
}

#[tauri::command]
fn add_storage_source(
    app: tauri::AppHandle,
    path: String,
    kind: Option<String>,
) -> Result<WorkspaceSnapshot, String> {
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("无法打开所选目录：{error}"))?;
    if !root.is_dir() {
        return Err("所选路径不是目录".to_owned());
    }
    let kind = kind.unwrap_or_else(|| "local".to_owned());
    if !matches!(kind.as_str(), "local" | "smb") {
        return Err("不支持的存储源类型".to_owned());
    }
    let existing_settings = load_settings(&app)?;
    let (mut sources, _) = workspace_sources(&app)?;
    let source = source_from_path(root, kind);
    if !sources.iter().any(|item| item.id == source.id) {
        sources.push(source);
    }
    let settings = WorkspaceSettings {
        name: existing_settings.name,
        path: String::new(),
        kind: String::new(),
        sources,
        s3_providers: existing_settings.s3_providers,
    };
    save_settings(&app, &settings)?;
    load_workspace(app)
}

#[tauri::command]
fn save_page(
    app: tauri::AppHandle,
    page: Page,
    expected_updated_at: Option<String>,
    write_source_id: Option<String>,
) -> Result<Page, String> {
    let page = normalize_page_sources(page);
    let (sources, _) = workspace_sources(&app)?;
    let write_id = write_source_id
        .as_deref()
        .unwrap_or(page.storage_source_id.as_str());
    let source = sources
        .iter()
        .find(|source| source.id == write_id)
        .ok_or("页面所属存储源不存在")?;
    let root = PathBuf::from(&source.path);
    fs::create_dir_all(root.join("pages")).map_err(|error| error.to_string())?;
    let path = markdown_path(&root, &page.id);
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(previous) = parse_page(&content) {
            if let Some(expected) = &expected_updated_at {
                if previous.updated_at != *expected {
                    return Err("页面已在其他设备更新，请重新载入后再保存".to_owned());
                }
            }
            if page_has_changed(&previous, &page) {
                archive_page_revision(&root, &previous)?;
            }
        }
    }
    fs::write(path, frontmatter(&page)).map_err(|error| error.to_string())?;
    Ok(page)
}

#[tauri::command]
fn list_page_revisions(
    app: tauri::AppHandle,
    page_id: String,
    storage_source_id: String,
) -> Result<Vec<PageRevision>, String> {
    let (sources, _) = workspace_sources(&app)?;
    let source = sources
        .iter()
        .find(|source| source.id == storage_source_id)
        .ok_or("页面所属存储源不存在")?;
    let directory = revision_dir(&PathBuf::from(&source.path), &page_id);
    let mut revisions = Vec::new();
    if !directory.exists() {
        return Ok(revisions);
    }
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if !path.extension().is_some_and(|extension| extension == "md") {
            continue;
        }
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let page = parse_page(&content).map_err(|error| format!("{}: {error}", path.display()))?;
        let id = path
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or("版本文件名无效")?
            .to_owned();
        revisions.push(PageRevision {
            id,
            saved_at: page.updated_at,
            title: page.title,
        });
    }
    revisions.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(revisions)
}

#[tauri::command]
fn read_page_revision(
    app: tauri::AppHandle,
    page: Page,
    revision_id: String,
) -> Result<Page, String> {
    let (sources, _) = workspace_sources(&app)?;
    let source = sources
        .iter()
        .find(|source| source.id == page.storage_source_id)
        .ok_or("页面所属存储源不存在")?;
    let path =
        revision_dir(&PathBuf::from(&source.path), &page.id).join(format!("{revision_id}.md"));
    let content = fs::read_to_string(path).map_err(|error| format!("无法读取历史版本：{error}"))?;
    parse_page(&content)
}

#[tauri::command]
fn restore_page_revision(
    app: tauri::AppHandle,
    page: Page,
    revision_id: String,
) -> Result<Page, String> {
    let (sources, _) = workspace_sources(&app)?;
    let source = sources
        .iter()
        .find(|source| source.id == page.storage_source_id)
        .ok_or("页面所属存储源不存在")?;
    let path =
        revision_dir(&PathBuf::from(&source.path), &page.id).join(format!("{revision_id}.md"));
    let content = fs::read_to_string(path).map_err(|error| format!("无法读取历史版本：{error}"))?;
    let revision = parse_page(&content)?;
    let restored = Page {
        id: page.id,
        storage_source_id: page.storage_source_id.clone(),
        storage_source_ids: if page.storage_source_ids.is_empty() {
            revision.storage_source_ids.clone()
        } else {
            page.storage_source_ids.clone()
        },
        created_at: page.created_at.clone(),
        updated_at: page.updated_at,
        ..revision
    };
    save_page(app, restored, None, None)
}

#[derive(serde::Deserialize)]
struct ExportAssetPayload {
    name: String,
    data: Vec<u8>,
}

#[tauri::command]
fn export_page_markdown(page: Page, target_path: String) -> Result<(), String> {
    export_page_markdown_bundle(page.markdown, target_path, Vec::new())
}

#[tauri::command]
fn export_page_markdown_bundle(
    markdown: String,
    target_path: String,
    assets: Vec<ExportAssetPayload>,
) -> Result<(), String> {
    let path = PathBuf::from(&target_path);
    if path.extension().is_none() {
        return Err("导出文件需要使用 .md 扩展名".to_owned());
    }
    fs::write(&path, markdown).map_err(|error| format!("无法导出 Markdown：{error}"))?;
    if assets.is_empty() {
        return Ok(());
    }
    let assets_dir = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("assets");
    fs::create_dir_all(&assets_dir)
        .map_err(|error| format!("无法创建附件目录：{error}"))?;
    for asset in assets {
        if asset.name.contains('/')
            || asset.name.contains('\\')
            || asset.name.contains("..")
            || asset.name.is_empty()
        {
            return Err(format!("非法附件名：{}", asset.name));
        }
        let asset_path = assets_dir.join(&asset.name);
        fs::write(asset_path, asset.data)
            .map_err(|error| format!("无法导出附件 {}：{error}", asset.name))?;
    }
    Ok(())
}

#[tauri::command]
fn permanently_delete_pages(app: tauri::AppHandle, pages: Vec<Page>) -> Result<(), String> {
    let (sources, _) = workspace_sources(&app)?;
    for page in pages {
        let source = sources
            .iter()
            .find(|source| source.id == page.storage_source_id)
            .ok_or("页面所属存储源不存在")?;
        let root = PathBuf::from(&source.path);
        let markdown = markdown_path(&root, &page.id);
        if markdown.exists() {
            fs::remove_file(markdown).map_err(|error| format!("无法彻底删除页面：{error}"))?;
        }
        let history = revision_dir(&root, &page.id);
        if history.exists() {
            fs::remove_dir_all(history).map_err(|error| format!("无法移除页面历史：{error}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn transfer_page_storage(
    app: tauri::AppHandle,
    page: Page,
    target_source_id: String,
) -> Result<Page, String> {
    if page.storage_source_id == target_source_id {
        return Ok(page);
    }
    let (sources, _) = workspace_sources(&app)?;
    let source = sources
        .iter()
        .find(|source| source.id == page.storage_source_id)
        .ok_or("页面原存储源不存在")?;
    let target = sources
        .iter()
        .find(|source| source.id == target_source_id)
        .ok_or("目标存储源不存在")?;
    let source_root = PathBuf::from(&source.path);
    let source_path = markdown_path(&source_root, &page.id);
    if !source_path.exists() {
        return Err("原页面文件不存在，无法迁移".to_owned());
    }
    let target_root = PathBuf::from(&target.path);
    fs::create_dir_all(target_root.join("pages")).map_err(|error| error.to_string())?;
    let target_path = markdown_path(&target_root, &page.id);
    if target_path.exists() {
        return Err("目标存储源中已存在相同页面 ID，无法迁移".to_owned());
    }
    let transferred = normalize_page_sources(Page {
        storage_source_id: target_source_id.clone(),
        storage_source_ids: vec![target_source_id],
        ..page
    });
    fs::write(&target_path, frontmatter(&transferred)).map_err(|error| error.to_string())?;
    if let Err(error) = copy_page_history(&source_root, &target_root, &transferred.id) {
        let _ = fs::remove_file(&target_path);
        return Err(error);
    }
    if let Err(error) = copy_page_assets(&source_root, &target_root, &transferred.id) {
        let _ = fs::remove_file(&target_path);
        let _ = fs::remove_dir_all(revision_dir(&target_root, &transferred.id));
        let _ = remove_page_assets(&target_root, &transferred.id);
        return Err(error);
    }
    if let Err(error) = fs::remove_file(source_path) {
        let _ = fs::remove_file(&target_path);
        let _ = fs::remove_dir_all(revision_dir(&target_root, &transferred.id));
        let _ = remove_page_assets(&target_root, &transferred.id);
        return Err(format!("无法移除原页面文件，迁移已取消：{error}"));
    }
    let source_history = revision_dir(&source_root, &transferred.id);
    if source_history.exists() {
        let _ = fs::remove_dir_all(source_history);
    }
    let _ = remove_page_assets(&source_root, &transferred.id);
    Ok(transferred)
}

fn imported_page_id(path: &Path, target_source_id: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    target_source_id.hash(&mut hasher);
    format!("pg_import_{:016x}", hasher.finish())
}

fn importable_page(content: String, fallback_title: String) -> (String, String, Vec<String>) {
    if let Ok(page) = parse_page(&content) {
        return (page.title, page.markdown, page.tags);
    }
    let title = content
        .lines()
        .find_map(|line| line.strip_prefix("# "))
        .filter(|title| !title.trim().is_empty())
        .unwrap_or(&fallback_title)
        .to_owned();
    let markdown = if content.lines().any(|line| line.starts_with("# ")) {
        content
    } else {
        format!("# {title}\n\n{content}")
    };
    (title, markdown, Vec::new())
}

struct ImportCandidate {
    page_id: String,
    destination: PathBuf,
    content: String,
    fallback_title: String,
    original_page: Option<Page>,
    destination_exists: bool,
}

fn remap_imported_links(markdown: String, page_ids: &HashMap<String, String>) -> String {
    page_ids.iter().fold(markdown, |content, (old_id, new_id)| {
        content.replace(
            &format!("tie://page/{old_id}"),
            &format!("tie://page/{new_id}"),
        )
    })
}

#[tauri::command]
fn import_markdown_files(
    app: tauri::AppHandle,
    paths: Vec<String>,
    target_source_id: String,
    created_at: String,
) -> Result<WorkspaceSnapshot, String> {
    let (sources, _) = workspace_sources(&app)?;
    let target = sources
        .iter()
        .find(|source| source.id == target_source_id)
        .ok_or("目标存储源不存在")?;
    let target_root = PathBuf::from(&target.path);
    let target_pages = target_root.join("pages");
    fs::create_dir_all(&target_pages).map_err(|error| error.to_string())?;
    let mut sort_key = fs::read_dir(&target_pages)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "md")
        })
        .count() as i64;
    let mut imports = Vec::new();
    let mut imported_ids = HashMap::new();
    for raw_path in paths {
        let path = PathBuf::from(raw_path)
            .canonicalize()
            .map_err(|error| format!("无法读取导入文件：{error}"))?;
        if !path.is_file()
            || !path.extension().is_some_and(|extension| {
                extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
            })
        {
            continue;
        }
        let page_id = imported_page_id(&path, &target_source_id);
        let destination = markdown_path(&target_root, &page_id);
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let fallback_title = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("导入的页面")
            .to_owned();
        let original_page = parse_page(&content).ok();
        if let Some(page) = &original_page {
            if !page.id.is_empty() {
                imported_ids.insert(page.id.clone(), page_id.clone());
            }
        }
        imports.push(ImportCandidate {
            page_id,
            destination_exists: destination.exists(),
            destination,
            content,
            fallback_title,
            original_page,
        });
    }
    for candidate in imports {
        if candidate.destination_exists {
            continue;
        }
        let (title, icon, markdown, tags, parent_id, page_sort_key) =
            if let Some(original) = candidate.original_page {
                let parent_id = original
                    .parent_id
                    .as_ref()
                    .and_then(|parent_id| imported_ids.get(parent_id))
                    .cloned();
                let page_sort_key = if parent_id.is_some() {
                    original.sort_key
                } else {
                    let current = sort_key;
                    sort_key += 1;
                    current
                };
                (
                    original.title,
                    original.icon,
                    remap_imported_links(original.markdown, &imported_ids),
                    original.tags,
                    parent_id,
                    page_sort_key,
                )
            } else {
                let (title, markdown, tags) =
                    importable_page(candidate.content, candidate.fallback_title);
                let current = sort_key;
                sort_key += 1;
                (title, String::new(), markdown, tags, None, current)
            };
        let page = Page {
            id: candidate.page_id,
            title,
            icon,
            parent_id,
            sort_key: page_sort_key,
            markdown,
            tags,
            created_at: created_at.clone(),
            updated_at: created_at.clone(),
            deleted_at: None,
            storage_source_id: target_source_id.clone(),
            storage_source_ids: vec![target_source_id.clone()],
        };
        fs::write(candidate.destination, frontmatter(&page)).map_err(|error| error.to_string())?;
    }
    load_workspace(app)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenMarkdownFilesResult {
    snapshot: WorkspaceSnapshot,
    opened_page_ids: Vec<String>,
    created_source_ids: Vec<String>,
}

fn path_is_markdown(path: &Path) -> bool {
    path.is_file()
        && path.extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
}

fn infer_workspace_root_for_file(file: &Path) -> PathBuf {
    let parent = file
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    if parent
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("pages"))
    {
        if let Some(root) = parent.parent() {
            return root.to_path_buf();
        }
    }
    let mut cursor = parent.clone();
    for _ in 0..5 {
        if cursor.join("pages").is_dir() {
            return cursor;
        }
        match cursor.parent() {
            Some(next) => cursor = next.to_path_buf(),
            None => break,
        }
    }
    parent
}

fn find_source_covering_path<'a>(
    sources: &'a [StorageSource],
    file: &Path,
) -> Option<&'a StorageSource> {
    sources.iter().find(|source| {
        let root = PathBuf::from(&source.path);
        let Ok(root) = root.canonicalize() else {
            return file.starts_with(Path::new(&source.path));
        };
        file.starts_with(&root)
    })
}

fn ensure_local_source_at(
    app: &tauri::AppHandle,
    root: PathBuf,
) -> Result<(StorageSource, bool), String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("无法打开工作区目录：{error}"))?;
    if !root.is_dir() {
        return Err("工作区路径不是目录".to_owned());
    }
    fs::create_dir_all(root.join("pages")).map_err(|error| error.to_string())?;

    let existing_settings = load_settings(app)?;
    let (mut sources, _) = workspace_sources(app)?;
    if let Some(existing) = sources.iter().find(|source| {
        PathBuf::from(&source.path)
            .canonicalize()
            .map(|path| path == root)
            .unwrap_or(false)
    }) {
        return Ok((existing.clone(), false));
    }

    let source = source_from_path(root, "local".to_owned());
    sources.push(source.clone());
    let settings = WorkspaceSettings {
        name: existing_settings.name,
        path: String::new(),
        kind: String::new(),
        sources,
        s3_providers: existing_settings.s3_providers,
    };
    save_settings(app, &settings)?;
    Ok((source, true))
}

fn try_existing_page_id(root: &Path, file: &Path) -> Option<String> {
    let pages_dir = root.join("pages");
    let canon_file = file.canonicalize().ok()?;
    let canon_pages = pages_dir.canonicalize().ok()?;
    if !canon_file.starts_with(&canon_pages) {
        return None;
    }
    let content = fs::read_to_string(file).ok()?;
    let page = parse_page(&content).ok()?;
    let expected = markdown_path(root, &page.id);
    if expected.canonicalize().ok().as_ref() == Some(&canon_file) {
        return Some(page.id);
    }
    // Still prefer frontmatter id when the file already lives under pages/.
    Some(page.id)
}

fn import_single_markdown_file(
    root: &Path,
    source_id: &str,
    file: &Path,
    created_at: &str,
) -> Result<String, String> {
    if let Some(existing_id) = try_existing_page_id(root, file) {
        return Ok(existing_id);
    }

    let pages_dir = root.join("pages");
    fs::create_dir_all(&pages_dir).map_err(|error| error.to_string())?;
    let sort_key = fs::read_dir(&pages_dir)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "md")
        })
        .count() as i64;

    let page_id = imported_page_id(file, source_id);
    let destination = markdown_path(root, &page_id);
    if destination.exists() {
        return Ok(page_id);
    }

    let content = fs::read_to_string(file).map_err(|error| error.to_string())?;
    let fallback_title = file
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("打开的页面")
        .to_owned();
    let (title, icon, markdown, tags, parent_id, page_sort_key) =
        if let Ok(original) = parse_page(&content) {
            (
                original.title,
                original.icon,
                original.markdown,
                original.tags,
                None,
                sort_key,
            )
        } else {
            let (title, markdown, tags) = importable_page(content, fallback_title);
            (title, String::new(), markdown, tags, None, sort_key)
        };

    let page = Page {
        id: page_id.clone(),
        title,
        icon,
        parent_id,
        sort_key: page_sort_key,
        markdown,
        tags,
        created_at: created_at.to_owned(),
        updated_at: created_at.to_owned(),
        deleted_at: None,
        storage_source_id: source_id.to_owned(),
        storage_source_ids: vec![source_id.to_owned()],
    };
    fs::write(destination, frontmatter(&page)).map_err(|error| error.to_string())?;
    Ok(page_id)
}

#[tauri::command]
fn open_markdown_files(
    app: tauri::AppHandle,
    paths: Vec<String>,
    created_at: String,
) -> Result<OpenMarkdownFilesResult, String> {
    let mut opened_page_ids = Vec::new();
    let mut created_source_ids = Vec::new();

    for raw_path in paths {
        let file = PathBuf::from(raw_path.trim())
            .canonicalize()
            .map_err(|error| format!("无法打开文件：{error}"))?;
        if !path_is_markdown(&file) {
            continue;
        }

        let (sources, _) = workspace_sources(&app)?;
        let (source, created) = if let Some(existing) = find_source_covering_path(&sources, &file) {
            (existing.clone(), false)
        } else {
            let root = infer_workspace_root_for_file(&file);
            ensure_local_source_at(&app, root)?
        };
        if created {
            created_source_ids.push(source.id.clone());
        }

        let page_id = import_single_markdown_file(
            Path::new(&source.path),
            &source.id,
            &file,
            &created_at,
        )?;
        if !opened_page_ids.contains(&page_id) {
            opened_page_ids.push(page_id);
        }
    }

    if opened_page_ids.is_empty() {
        return Err("未选择有效的 Markdown 文件".to_owned());
    }

    Ok(OpenMarkdownFilesResult {
        snapshot: load_workspace(app)?,
        opened_page_ids,
        created_source_ids,
    })
}

#[tauri::command]
fn remove_storage_source(
    app: tauri::AppHandle,
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
        let pages_dir = PathBuf::from(&source.path).join("pages");
        let entries = fs::read_dir(pages_dir)
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
    load_workspace(app)
}

#[tauri::command]
fn rename_storage_source(
    app: tauri::AppHandle,
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
    load_workspace(app)
}

#[tauri::command]
fn rename_workspace(app: tauri::AppHandle, name: String) -> Result<WorkspaceSnapshot, String> {
    let clean_name = name.trim();
    if clean_name.is_empty() || clean_name.chars().count() > 80 {
        return Err("工作区名称需为 1 至 80 个字符".to_owned());
    }
    let mut settings = load_settings(&app)?;
    settings.name = clean_name.to_owned();
    save_settings(&app, &settings)?;
    load_workspace(app)
}

fn s3_page_object(page_id: &str) -> String {
    format!("tie/pages/{page_id}.md")
}

fn s3_history_prefix(page_id: &str) -> String {
    format!("tie/history/{page_id}/")
}

fn s3_history_object(page_id: &str, revision_id: &str) -> String {
    format!("tie/history/{page_id}/{revision_id}.md")
}

async fn list_s3_object_keys(
    client: &MinioClient,
    bucket: BucketName,
    prefix: &str,
) -> Result<Vec<String>, String> {
    let mut stream = client.list_objects(bucket)
        .map_err(|error| format!("无法列出 S3 对象：{error}"))?
        .prefix(Some(prefix.to_owned()))
        .recursive(true)
        .build()
        .to_stream()
        .await;
    let mut keys = Vec::new();
    while let Some(batch) = stream.next().await {
        let batch = batch.map_err(|error| format!("无法读取 S3 对象列表：{error}"))?;
        for entry in batch.contents {
            keys.push(entry.name);
        }
    }
    Ok(keys)
}

async fn trim_s3_history(client: &MinioClient, bucket: BucketName, page_id: &str) -> Result<(), String> {
    let prefix = s3_history_prefix(page_id);
    let mut keys = list_s3_object_keys(client, bucket.clone(), &prefix).await?;
    keys.sort();
    while keys.len() > MAX_PAGE_REVISIONS {
        let oldest = keys.remove(0);
        client.delete_object(bucket.clone(), oldest)
            .map_err(|error| format!("无法清理 S3 历史版本：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法清理 S3 历史版本：{error}"))?;
    }
    Ok(())
}

async fn archive_s3_page_revision(
    client: &MinioClient,
    bucket: BucketName,
    page: &Page,
) -> Result<(), String> {
    let revision_key = s3_history_object(&page.id, &revision_id());
    client.put_object_content(bucket.clone(), revision_key, ObjectContent::from(frontmatter(page)))
        .map_err(|error| format!("无法写入 S3 历史版本：{error}"))?
        .build()
        .send()
        .await
        .map_err(|error| format!("无法写入 S3 历史版本：{error}"))?;
    trim_s3_history(client, bucket, &page.id).await
}

async fn delete_s3_history(client: &MinioClient, bucket: BucketName, page_id: &str) -> Result<(), String> {
    for key in list_s3_object_keys(client, bucket.clone(), &s3_history_prefix(page_id)).await? {
        client.delete_object(bucket.clone(), key)
            .map_err(|error| format!("无法删除 S3 历史版本：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法删除 S3 历史版本：{error}"))?;
    }
    Ok(())
}

fn file_source_root(app: &tauri::AppHandle, source_id: &str) -> Result<PathBuf, String> {
    let (sources, _) = workspace_sources(app)?;
    let source = sources
        .iter()
        .find(|source| source.id == source_id)
        .ok_or("存储源不存在")?;
    Ok(PathBuf::from(&source.path))
}

#[tauri::command]
fn load_s3_providers(app: tauri::AppHandle) -> Result<Vec<S3ProviderConfig>, String> {
    Ok(load_settings(&app)?.s3_providers)
}

#[tauri::command]
fn save_s3_providers(app: tauri::AppHandle, providers: Vec<S3ProviderConfig>) -> Result<(), String> {
    let mut settings = load_settings(&app)?;
    settings.s3_providers = providers;
    save_settings(&app, &settings)
}

#[tauri::command]
fn upsert_s3_provider(app: tauri::AppHandle, provider: S3ProviderConfig) -> Result<Vec<S3ProviderConfig>, String> {
    let mut settings = load_settings(&app)?;
    if let Some(existing) = settings.s3_providers.iter_mut().find(|item| item.id == provider.id) {
        *existing = provider;
    } else {
        settings.s3_providers.push(provider);
    }
    save_settings(&app, &settings)?;
    Ok(settings.s3_providers)
}

#[tauri::command]
fn remove_s3_provider_config(app: tauri::AppHandle, provider_id: String) -> Result<Vec<S3ProviderConfig>, String> {
    let mut settings = load_settings(&app)?;
    settings.s3_providers.retain(|provider| provider.id != provider_id);
    save_settings(&app, &settings)?;
    Ok(settings.s3_providers)
}

#[tauri::command]
async fn list_s3_page_revisions(connection: S3Connection, page_id: String) -> Result<Vec<PageRevision>, String> {
    let (client, bucket) = s3_client(&connection)?;
    let mut revisions = Vec::new();
    for key in list_s3_object_keys(&client, bucket.clone(), &s3_history_prefix(&page_id)).await? {
        if !key.ends_with(".md") {
            continue;
        }
        let response = client.get_object(bucket.clone(), key.clone())
            .map_err(|error| format!("无法读取 S3 历史版本：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法下载 S3 历史版本：{error}"))?;
        let content = String::from_utf8(response.into_bytes().await.map_err(|error| format!("无法读取 S3 历史版本内容：{error}"))?.to_vec())
            .map_err(|_| "S3 历史版本不是 UTF-8 Markdown 文件".to_owned())?;
        let page = parse_page(&content).map_err(|error| format!("S3 历史版本格式无效：{error}"))?;
        let id = key
            .trim_start_matches(&s3_history_prefix(&page_id))
            .trim_end_matches(".md")
            .to_owned();
        revisions.push(PageRevision {
            id,
            saved_at: page.updated_at,
            title: page.title,
        });
    }
    revisions.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(revisions)
}

#[tauri::command]
async fn read_s3_page_revision(connection: S3Connection, page: Page, revision_id: String) -> Result<Page, String> {
    let (client, bucket) = s3_client(&connection)?;
    let key = s3_history_object(&page.id, &revision_id);
    let mut revision = download_s3_page(&client, bucket, &page.storage_source_id, key).await?;
    revision.id = page.id;
    revision.storage_source_id = page.storage_source_id;
    revision.created_at = page.created_at;
    Ok(revision)
}

#[tauri::command]
async fn copy_file_history_to_s3(
    app: tauri::AppHandle,
    page_id: String,
    file_source_id: String,
    connection: S3Connection,
) -> Result<(), String> {
    let root = file_source_root(&app, &file_source_id)?;
    let source_directory = revision_dir(&root, &page_id);
    if !source_directory.exists() {
        return Ok(());
    }
    let (client, bucket) = s3_client(&connection)?;
    for entry in fs::read_dir(source_directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if !path.extension().is_some_and(|extension| extension == "md") {
            continue;
        }
        let revision_id = path
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or("版本文件名无效")?;
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        client.put_object_content(
            bucket.clone(),
            s3_history_object(&page_id, revision_id),
            ObjectContent::from(content),
        )
        .map_err(|error| format!("无法复制历史版本到 S3：{error}"))?
        .build()
        .send()
        .await
        .map_err(|error| format!("无法复制历史版本到 S3：{error}"))?;
    }
    trim_s3_history(&client, bucket, &page_id).await
}

#[tauri::command]
async fn copy_s3_history_to_file(
    app: tauri::AppHandle,
    connection: S3Connection,
    page_id: String,
    file_source_id: String,
) -> Result<(), String> {
    let root = file_source_root(&app, &file_source_id)?;
    let target_directory = revision_dir(&root, &page_id);
    if target_directory.exists() {
        return Err("目标存储源中已存在该页面的历史记录，无法迁移".to_owned());
    }
    let (client, bucket) = s3_client(&connection)?;
    let keys = list_s3_object_keys(&client, bucket.clone(), &s3_history_prefix(&page_id)).await?;
    if keys.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(&target_directory).map_err(|error| error.to_string())?;
    for key in keys {
        if !key.ends_with(".md") {
            continue;
        }
        let revision_id = {
            let prefix = s3_history_prefix(&page_id);
            key.strip_prefix(&prefix)
                .and_then(|name| name.strip_suffix(".md"))
                .unwrap_or(&key)
                .to_owned()
        };
        let response = client.get_object(bucket.clone(), key)
            .map_err(|error| format!("无法读取 S3 历史版本：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法下载 S3 历史版本：{error}"))?;
        let content = String::from_utf8(response.into_bytes().await.map_err(|error| format!("无法读取 S3 历史版本内容：{error}"))?.to_vec())
            .map_err(|_| "S3 历史版本不是 UTF-8 Markdown 文件".to_owned())?;
        fs::write(target_directory.join(format!("{revision_id}.md")), content)
            .map_err(|error| format!("无法写入本地历史版本：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn copy_s3_history_to_s3(
    source: S3Connection,
    target: S3Connection,
    page_id: String,
) -> Result<(), String> {
    let (source_client, source_bucket) = s3_client(&source)?;
    let (target_client, target_bucket) = s3_client(&target)?;
    let keys = list_s3_object_keys(&source_client, source_bucket.clone(), &s3_history_prefix(&page_id)).await?;
    for key in keys {
        if !key.ends_with(".md") {
            continue;
        }
        let response = source_client.get_object(source_bucket.clone(), key.clone())
            .map_err(|error| format!("无法读取 S3 历史版本：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法下载 S3 历史版本：{error}"))?;
        let content = response.into_bytes().await.map_err(|error| format!("无法读取 S3 历史版本内容：{error}"))?;
        target_client.put_object_content(target_bucket.clone(), key, ObjectContent::from(content.to_vec()))
            .map_err(|error| format!("无法复制 S3 历史版本：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法复制 S3 历史版本：{error}"))?;
    }
    trim_s3_history(&target_client, target_bucket, &page_id).await
}

fn s3_asset_prefix(page_id: &str) -> String {
    format!("tie/assets/{page_id}/")
}

#[tauri::command]
async fn copy_file_assets_to_s3(
    app: tauri::AppHandle,
    page_id: String,
    file_source_id: String,
    connection: S3Connection,
) -> Result<(), String> {
    let root = file_source_root(&app, &file_source_id)?;
    let source_directory = page_asset_dir(&root, &page_id);
    if !source_directory.exists() {
        return Ok(());
    }
    let (client, bucket) = s3_client(&connection)?;
    for entry in fs::read_dir(source_directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if !path.is_file() {
            continue;
        }
        let asset_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("附件名称无效")?;
        let sanitized = sanitize_asset_name(asset_name)?;
        let data = fs::read(&path).map_err(|error| error.to_string())?;
        client.put_object_content(
            bucket.clone(),
            s3_asset_object(&page_id, &sanitized),
            ObjectContent::from(data),
        )
        .map_err(|error| format!("无法复制附件到 S3：{error}"))?
        .build()
        .send()
        .await
        .map_err(|error| format!("无法复制附件到 S3：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn copy_s3_assets_to_file(
    app: tauri::AppHandle,
    connection: S3Connection,
    page_id: String,
    file_source_id: String,
) -> Result<(), String> {
    let root = file_source_root(&app, &file_source_id)?;
    let target_directory = page_asset_dir(&root, &page_id);
    let (client, bucket) = s3_client(&connection)?;
    let keys = list_s3_object_keys(&client, bucket.clone(), &s3_asset_prefix(&page_id)).await?;
    if keys.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(&target_directory).map_err(|error| error.to_string())?;
    for key in keys {
        let asset_name = key
            .strip_prefix(&s3_asset_prefix(&page_id))
            .ok_or("S3 附件路径无效")?;
        let sanitized = sanitize_asset_name(asset_name)?;
        let response = client.get_object(bucket.clone(), key)
            .map_err(|error| format!("无法读取 S3 附件：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法下载 S3 附件：{error}"))?;
        let data = response.into_bytes().await.map_err(|error| format!("无法读取 S3 附件内容：{error}"))?;
        fs::write(target_directory.join(&sanitized), data.to_vec())
            .map_err(|error| format!("无法写入本地附件：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn copy_s3_assets_to_s3(
    source: S3Connection,
    target: S3Connection,
    page_id: String,
) -> Result<(), String> {
    let (source_client, source_bucket) = s3_client(&source)?;
    let (target_client, target_bucket) = s3_client(&target)?;
    let keys = list_s3_object_keys(&source_client, source_bucket.clone(), &s3_asset_prefix(&page_id)).await?;
    for key in keys {
        let response = source_client.get_object(source_bucket.clone(), key.clone())
            .map_err(|error| format!("无法读取 S3 附件：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法下载 S3 附件：{error}"))?;
        let data = response.into_bytes().await.map_err(|error| format!("无法读取 S3 附件内容：{error}"))?;
        target_client.put_object_content(target_bucket.clone(), key, ObjectContent::from(data.to_vec()))
            .map_err(|error| format!("无法复制 S3 附件：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法复制 S3 附件：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn list_s3_page_assets(connection: S3Connection, page: Page) -> Result<Vec<String>, String> {
    let (client, bucket) = s3_client(&connection)?;
    let keys = list_s3_object_keys(&client, bucket, &s3_asset_prefix(&page.id)).await?;
    Ok(keys
        .into_iter()
        .filter_map(|key| key.strip_prefix(&s3_asset_prefix(&page.id)).map(str::to_owned))
        .collect())
}

#[tauri::command]
fn save_s3_credentials(provider_id: String, access_key: String, secret_key: String) -> Result<(), String> {
    if access_key.trim().is_empty() || secret_key.is_empty() {
        return Err("Access Key 和 Secret Key 不能为空".to_owned());
    }
    let payload = serde_json::to_string(&S3Credentials {
        access_key: access_key.trim().to_owned(),
        secret_key,
    })
    .map_err(|error| error.to_string())?;
    s3_credential_entry(&provider_id)?
        .set_password(&payload)
        .map_err(|error| format!("无法保存到系统凭据库：{error}"))
}

#[tauri::command]
fn remove_s3_credentials(provider_id: String) -> Result<(), String> {
    match s3_credential_entry(&provider_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法从系统凭据库移除：{error}")),
    }
}

#[tauri::command]
async fn test_s3_connection(provider_id: String, endpoint: String, bucket: String, region: Option<String>) -> Result<(), String> {
    let (client, bucket) = s3_client(&S3Connection { provider_id, endpoint, bucket, region })?;
    let response: BucketExistsResponse = client.bucket_exists(bucket)
        .map_err(|error| format!("无法检查 Bucket：{error}"))?
        .build()
        .send()
        .await
        .map_err(|error| format!("无法连接 S3：{error}"))?;
    if response.exists() { Ok(()) } else { Err("已连接 S3，但指定 Bucket 不存在或当前密钥无权访问".to_owned()) }
}

#[tauri::command]
async fn list_s3_page_index(connection: S3Connection) -> Result<Vec<S3PageIndexEntry>, String> {
    list_s3_object_index(&connection).await
}

#[tauri::command]
async fn load_s3_pages(connection: S3Connection) -> Result<Vec<Page>, String> {
    let source_id = format!("s3:{}", connection.provider_id);
    let (client, bucket) = s3_client(&connection)?;
    let index = list_s3_object_index(&connection).await?;
    let mut pages = Vec::with_capacity(index.len());
    for entry in index {
        pages.push(download_s3_page(&client, bucket.clone(), &source_id, format!("tie/pages/{}.md", entry.page_id)).await?);
    }
    Ok(pages)
}

#[tauri::command]
async fn load_s3_pages_by_ids(connection: S3Connection, page_ids: Vec<String>) -> Result<Vec<Page>, String> {
    let source_id = format!("s3:{}", connection.provider_id);
    let (client, bucket) = s3_client(&connection)?;
    let mut pages = Vec::with_capacity(page_ids.len());
    for page_id in page_ids {
        pages.push(download_s3_page(&client, bucket.clone(), &source_id, format!("tie/pages/{page_id}.md")).await?);
    }
    Ok(pages)
}

#[tauri::command]
async fn save_s3_page(
    connection: S3Connection,
    page: Page,
    expected_updated_at: Option<String>,
) -> Result<Page, String> {
    let (client, bucket) = s3_client(&connection)?;
    let object = s3_page_object(&page.id);
    if let Ok(previous) = download_s3_page(&client, bucket.clone(), &page.storage_source_id, object.clone()).await {
        if let Some(expected) = expected_updated_at {
            if previous.updated_at != expected {
                return Err("页面已在其他设备更新，请重新载入后再保存".to_owned());
            }
        }
        if page_has_changed(&previous, &page) {
            archive_s3_page_revision(&client, bucket.clone(), &previous).await?;
        }
    }
    client.put_object_content(bucket, object, ObjectContent::from(frontmatter(&page)))
        .map_err(|error| format!("无法创建 S3 写入请求：{error}"))?
        .build()
        .send()
        .await
        .map_err(|error| format!("无法保存 S3 页面：{error}"))?;
    Ok(page)
}

#[tauri::command]
async fn permanently_delete_s3_pages(connection: S3Connection, page_ids: Vec<String>) -> Result<(), String> {
    let (client, bucket) = s3_client(&connection)?;
    for page_id in page_ids {
        delete_s3_history(&client, bucket.clone(), &page_id).await?;
        client.delete_object(bucket.clone(), s3_page_object(&page_id))
            .map_err(|error| format!("无法创建 S3 删除请求：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法彻底删除 S3 页面：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn copy_page_sidecars(
    app: tauri::AppHandle,
    page_id: String,
    from_source_id: String,
    to_source_id: String,
) -> Result<(), String> {
    if from_source_id == to_source_id {
        return Ok(());
    }
    let from_root = source_root(&app, &from_source_id)?;
    let to_root = source_root(&app, &to_source_id)?;
    copy_page_history(&from_root, &to_root, &page_id)?;
    copy_page_assets(&from_root, &to_root, &page_id)?;
    Ok(())
}

#[tauri::command]
fn save_file_page_asset(
    app: tauri::AppHandle,
    page: Page,
    file_name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    if data.is_empty() {
        return Err("附件内容为空".to_owned());
    }
    if data.len() > 20 * 1024 * 1024 {
        return Err("附件超过 20 MB".to_owned());
    }
    let root = source_root(&app, &page.storage_source_id)?;
    let asset_name = sanitize_asset_name(&file_name)?;
    let directory = page_asset_dir(&root, &page.id);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::write(directory.join(&asset_name), data).map_err(|error| error.to_string())?;
    Ok(asset_name)
}

#[tauri::command]
fn read_file_page_asset(app: tauri::AppHandle, page: Page, asset_name: String) -> Result<Vec<u8>, String> {
    let root = source_root(&app, &page.storage_source_id)?;
    let asset_name = sanitize_asset_name(&asset_name)?;
    fs::read(page_asset_dir(&root, &page.id).join(asset_name)).map_err(|error| error.to_string())
}

fn s3_asset_object(page_id: &str, asset_name: &str) -> String {
    format!("tie/assets/{page_id}/{asset_name}")
}

#[tauri::command]
async fn save_s3_page_asset(
    connection: S3Connection,
    page: Page,
    file_name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    if data.is_empty() {
        return Err("附件内容为空".to_owned());
    }
    if data.len() > 20 * 1024 * 1024 {
        return Err("附件超过 20 MB".to_owned());
    }
    let asset_name = sanitize_asset_name(&file_name)?;
    let (client, bucket) = s3_client(&connection)?;
    client
        .put_object_content(bucket, s3_asset_object(&page.id, &asset_name), ObjectContent::from(data))
        .map_err(|error| format!("无法创建 S3 附件写入请求：{error}"))?
        .build()
        .send()
        .await
        .map_err(|error| format!("无法保存 S3 附件：{error}"))?;
    Ok(asset_name)
}

#[tauri::command]
async fn read_s3_page_asset(
    connection: S3Connection,
    page: Page,
    asset_name: String,
) -> Result<Vec<u8>, String> {
    let asset_name = sanitize_asset_name(&asset_name)?;
    let (client, bucket) = s3_client(&connection)?;
    let response = client
        .get_object(bucket, s3_asset_object(&page.id, &asset_name))
        .map_err(|error| format!("无法读取 S3 附件：{error}"))?
        .build()
        .send()
        .await
        .map_err(|error| format!("无法下载 S3 附件：{error}"))?;
    Ok(response
        .into_bytes()
        .await
        .map_err(|error| format!("无法读取 S3 附件内容：{error}"))?
        .to_vec())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if let Some(icon) = app.default_window_icon().cloned() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_icon(icon);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            save_page,
            add_storage_source,
            transfer_page_storage,
            import_markdown_files,
            open_markdown_files,
            copy_page_sidecars,
            remove_storage_source,
            rename_storage_source,
            rename_workspace,
            save_s3_credentials,
            remove_s3_credentials,
            load_s3_providers,
            save_s3_providers,
            upsert_s3_provider,
            remove_s3_provider_config,
            test_s3_connection,
            list_s3_page_index,
            load_s3_pages,
            load_s3_pages_by_ids,
            save_s3_page,
            permanently_delete_s3_pages,
            list_s3_page_revisions,
            read_s3_page_revision,
            copy_file_history_to_s3,
            copy_s3_history_to_file,
            copy_s3_history_to_s3,
            copy_file_assets_to_s3,
            copy_s3_assets_to_file,
            copy_s3_assets_to_s3,
            list_file_page_assets,
            list_s3_page_assets,
            save_file_page_asset,
            read_file_page_asset,
            save_s3_page_asset,
            read_s3_page_asset,
            list_page_revisions,
            read_page_revision,
            restore_page_revision,
            export_page_markdown,
            export_page_markdown_bundle,
            permanently_delete_pages,
            ai_cli::ai_cli_status,
            ai_cli::ai_cli_suggest_tags,
            codex_mcp::agent_mcp_status,
            codex_mcp::configure_agent_mcp,
            codex_mcp::codex_mcp_status,
            codex_mcp::configure_codex_mcp,
            skills::list_skill_connections,
            skills::list_skill_scan_roots,
            skills::list_extra_skill_scan_roots,
            skills::add_skill_scan_root,
            skills::remove_skill_scan_root,
            skills::scan_skills,
            skills::connect_skill,
            skills::disconnect_skill,
            skills::read_skill_file,
            skills::write_skill_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tie desktop app");
}
