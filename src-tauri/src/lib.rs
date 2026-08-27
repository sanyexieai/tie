use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::Manager;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    id: String,
    name: String,
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSnapshot {
    workspace: Workspace,
    pages: Vec<Page>,
}

fn workspace_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("workspace");
    fs::create_dir_all(root.join("pages")).map_err(|error| error.to_string())?;
    Ok(root)
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
    format!("---\ntie_version: 1\nid: {}\nparent_id: {}\nsort_key: {}\ntags: [{}]\ncreated_at: {}\nupdated_at: {}\n{}---\n\n{}", page.id, parent, page.sort_key, tags, page.created_at, page.updated_at, deleted, page.markdown)
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
    })
}

fn demo_pages() -> Vec<Page> {
    let created = "2026-08-27T00:00:00.000Z".to_owned();
    vec![
    Page { id: "pg_inbox".into(), title: "收集箱".into(), parent_id: None, sort_key: 0, markdown: "# 收集箱\n\n把想法先放在这里，再慢慢整理。\n\n- 在页面内创建子页面\n- 直接用 Markdown 写作\n- 后续可通过链接、标签和图谱建立关联\n".into(), tags: vec!["收集".into()], created_at: created.clone(), updated_at: created.clone(), deleted_at: None },
    Page { id: "pg_welcome".into(), title: "欢迎使用 Tie".into(), parent_id: Some("pg_inbox".into()), sort_key: 0, markdown: "# 欢迎使用 Tie\n\nTie 把 **Notion 的页面树**、**Typora 的写作感** 和 **Obsidian 的链接关系** 放在一起。\n\n## 从这里开始\n\n1. 在左侧创建页面或子页面\n2. 直接用 Markdown 写作\n3. 用标签与链接整理知识\n".into(), tags: vec!["开始".into()], created_at: created.clone(), updated_at: created, deleted_at: None },
  ]
}

fn ensure_demo(root: &Path) -> Result<(), String> {
    if fs::read_dir(root.join("pages"))
        .map_err(|error| error.to_string())?
        .next()
        .is_none()
    {
        for page in demo_pages() {
            fs::write(markdown_path(root, &page.id), frontmatter(&page))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn load_workspace(app: tauri::AppHandle) -> Result<WorkspaceSnapshot, String> {
    let root = workspace_root(&app)?;
    ensure_demo(&root)?;
    let mut pages = Vec::new();
    for entry in fs::read_dir(root.join("pages")).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().is_some_and(|extension| extension == "md") {
            let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            pages.push(
                parse_page(&content).map_err(|error| format!("{}: {error}", path.display()))?,
            );
        }
    }
    Ok(WorkspaceSnapshot {
        workspace: Workspace {
            id: "local-main".into(),
            name: "我的知识库".into(),
            path: root.display().to_string(),
        },
        pages,
    })
}

#[tauri::command]
fn save_page(app: tauri::AppHandle, page: Page) -> Result<Page, String> {
    let root = workspace_root(&app)?;
    fs::write(markdown_path(&root, &page.id), frontmatter(&page))
        .map_err(|error| error.to_string())?;
    Ok(page)
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![load_workspace, save_page])
        .run(tauri::generate_context!())
        .expect("error while running Tie desktop app");
}
