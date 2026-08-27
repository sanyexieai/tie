use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    id: String,
    title: String,
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

#[derive(Deserialize, Serialize)]
struct WorkspaceSettings {
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

fn frontmatter(page: &Page) -> String {
    let parent = page.parent_id.clone().unwrap_or_default();
    let tags = page.tags.join(", ");
    let deleted = page
        .deleted_at
        .as_ref()
        .map(|value| format!("deleted_at: {value}\n"))
        .unwrap_or_default();
    format!("---\ntie_version: 1\nid: {}\nstorage_source_id: {}\nparent_id: {}\nsort_key: {}\ntags: [{}]\ncreated_at: {}\nupdated_at: {}\n{}---\n\n{}", page.id, page.storage_source_id, parent, page.sort_key, tags, page.created_at, page.updated_at, deleted, page.markdown)
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
    Page { id: "pg_inbox".into(), title: "收集箱".into(), parent_id: None, sort_key: 0, markdown: "# 收集箱\n\n把想法先放在这里，再慢慢整理。\n\n- 在页面内创建子页面\n- 直接用 Markdown 写作\n- 后续可通过链接、标签和图谱建立关联\n".into(), tags: vec!["收集".into()], created_at: created.clone(), updated_at: created.clone(), deleted_at: None, storage_source_id: storage_source_id.to_owned() },
    Page { id: "pg_welcome".into(), title: "欢迎使用 Tie".into(), parent_id: Some("pg_inbox".into()), sort_key: 0, markdown: "# 欢迎使用 Tie\n\nTie 把 **Notion 的页面树**、**Typora 的写作感** 和 **Obsidian 的链接关系** 放在一起。\n\n## 从这里开始\n\n1. 在左侧创建页面或子页面\n2. 直接用 Markdown 写作\n3. 用标签与链接整理知识\n".into(), tags: vec!["开始".into()], created_at: created.clone(), updated_at: created, deleted_at: None, storage_source_id: storage_source_id.to_owned() },
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
    let (sources, is_default_source) = workspace_sources(&app)?;
    if is_default_source {
        let root = PathBuf::from(&sources[0].path);
        fs::create_dir_all(root.join("pages")).map_err(|error| error.to_string())?;
        ensure_demo(&root, &sources[0].id)?;
    }
    let mut pages = Vec::new();
    for source in &sources {
        let root = PathBuf::from(&source.path);
        let pages_dir = root.join("pages");
        if fs::create_dir_all(&pages_dir).is_err() {
            continue;
        }
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
            name: "我的知识库".to_owned(),
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
    let (mut sources, _) = workspace_sources(&app)?;
    let source = source_from_path(root, kind);
    if !sources.iter().any(|item| item.id == source.id) {
        sources.push(source);
    }
    let settings = WorkspaceSettings {
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
    fs::write(markdown_path(&root, &page.id), frontmatter(&page))
        .map_err(|error| error.to_string())?;
    Ok(page)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            save_page,
            add_storage_source
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tie desktop app");
}
