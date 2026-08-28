use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

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
    let parent = page.parent_id.clone().unwrap_or_default();
    let tags = page.tags.join(", ");
    let deleted = page
        .deleted_at
        .as_ref()
        .map(|value| format!("deleted_at: {value}\n"))
        .unwrap_or_default();
    let icon = page.icon.replace(['\n', '\r'], "");
    format!("---\ntie_version: 1\nid: {}\nstorage_source_id: {}\nparent_id: {}\nsort_key: {}\nicon: {}\ntags: [{}]\ncreated_at: {}\nupdated_at: {}\n{}---\n\n{}", page.id, page.storage_source_id, parent, page.sort_key, icon, tags, page.created_at, page.updated_at, deleted, page.markdown)
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
    Ok(Page {
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
    })
}

fn demo_pages(storage_source_id: &str) -> Vec<Page> {
    let created = "2026-08-27T00:00:00.000Z".to_owned();
    vec![
    Page { id: "pg_inbox".into(), title: "收集箱".into(), icon: "📥".into(), parent_id: None, sort_key: 0, markdown: "# 收集箱\n\n把想法先放在这里，再慢慢整理。\n\n- 在页面内创建子页面\n- 直接用 Markdown 写作\n- 后续可通过链接、标签和图谱建立关联\n".into(), tags: vec!["收集".into()], created_at: created.clone(), updated_at: created.clone(), deleted_at: None, storage_source_id: storage_source_id.to_owned() },
    Page { id: "pg_welcome".into(), title: "欢迎使用 Tie".into(), icon: "👋".into(), parent_id: Some("pg_inbox".into()), sort_key: 0, markdown: "# 欢迎使用 Tie\n\nTie 把 **Notion 的页面树**、**Typora 的写作感** 和 **Obsidian 的链接关系** 放在一起。\n\n## 从这里开始\n\n1. 在左侧创建页面或子页面\n2. 直接用 Markdown 写作\n3. 用标签与链接整理知识\n".into(), tags: vec!["开始".into()], created_at: created.clone(), updated_at: created, deleted_at: None, storage_source_id: storage_source_id.to_owned() },
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
                pages.push(page);
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
        pages,
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
    };
    save_settings(&app, &settings)?;
    load_workspace(app)
}

#[tauri::command]
fn save_page(app: tauri::AppHandle, page: Page) -> Result<Page, String> {
    let (sources, _) = workspace_sources(&app)?;
    let source = sources
        .iter()
        .find(|source| source.id == page.storage_source_id)
        .ok_or("页面所属存储源不存在")?;
    let root = PathBuf::from(&source.path);
    fs::create_dir_all(root.join("pages")).map_err(|error| error.to_string())?;
    let path = markdown_path(&root, &page.id);
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(previous) = parse_page(&content) {
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
        created_at: page.created_at.clone(),
        updated_at: page.updated_at,
        ..revision
    };
    save_page(app, restored)
}

#[tauri::command]
fn export_page_markdown(page: Page, target_path: String) -> Result<(), String> {
    let path = PathBuf::from(target_path);
    if path.extension().is_none() {
        return Err("导出文件需要使用 .md 扩展名".to_owned());
    }
    fs::write(path, page.markdown).map_err(|error| format!("无法导出 Markdown：{error}"))
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
    let transferred = Page {
        storage_source_id: target_source_id,
        ..page
    };
    fs::write(&target_path, frontmatter(&transferred)).map_err(|error| error.to_string())?;
    if let Err(error) = copy_page_history(&source_root, &target_root, &transferred.id) {
        let _ = fs::remove_file(&target_path);
        return Err(error);
    }
    if let Err(error) = fs::remove_file(source_path) {
        let _ = fs::remove_file(&target_path);
        let _ = fs::remove_dir_all(revision_dir(&target_root, &transferred.id));
        return Err(format!("无法移除原页面文件，迁移已取消：{error}"));
    }
    let source_history = revision_dir(&source_root, &transferred.id);
    if source_history.exists() {
        let _ = fs::remove_dir_all(source_history);
    }
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
        };
        fs::write(candidate.destination, frontmatter(&page)).map_err(|error| error.to_string())?;
    }
    load_workspace(app)
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            save_page,
            add_storage_source,
            transfer_page_storage,
            import_markdown_files,
            remove_storage_source,
            rename_storage_source,
            rename_workspace,
            list_page_revisions,
            read_page_revision,
            restore_page_revision,
            export_page_markdown,
            permanently_delete_pages
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tie desktop app");
}
