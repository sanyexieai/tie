use super::types::*;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use super::paths::{markdown_path, page_asset_dir, revision_dir};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::{collections::HashMap, fs, path::Path};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn revision_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos}")
}

pub(crate) fn page_has_changed(before: &Page, after: &Page) -> bool {
    before.title != after.title
        || before.icon != after.icon
        || before.parent_id != after.parent_id
        || before.sort_key != after.sort_key
        || before.markdown != after.markdown
        || before.tags != after.tags
        || before.deleted_at != after.deleted_at
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn archive_page_revision(root: &Path, page: &Page) -> Result<(), String> {
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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn copy_page_assets(source_root: &Path, target_root: &Path, page_id: &str) -> Result<(), String> {
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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn remove_page_assets(root: &Path, page_id: &str) -> Result<(), String> {
    let directory = page_asset_dir(root, page_id);
    if directory.exists() {
        fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn copy_page_history(source_root: &Path, target_root: &Path, page_id: &str) -> Result<(), String> {
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

pub(crate) fn frontmatter(page: &Page) -> String {
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


#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn merge_loaded_pages(pages: Vec<Page>) -> Vec<Page> {
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

pub(crate) fn normalize_page_sources(mut page: Page) -> Page {
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

pub(crate) fn parse_page(content: &str) -> Result<Page, String> {
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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn demo_pages(storage_source_id: &str) -> Vec<Page> {
    let created = "2026-08-27T00:00:00.000Z".to_owned();
    vec![
    Page { id: "pg_inbox".into(), title: "收集箱".into(), icon: "📥".into(), parent_id: None, sort_key: 0, markdown: "# 收集箱\n\n把想法先放在这里，再慢慢整理。\n\n- 在页面内创建子页面\n- 直接用 Markdown 写作\n- 后续可通过链接、标签和图谱建立关联\n".into(), tags: vec!["收集".into()], created_at: created.clone(), updated_at: created.clone(), deleted_at: None, storage_source_id: storage_source_id.to_owned(), storage_source_ids: vec![storage_source_id.to_owned()] },
    Page { id: "pg_welcome".into(), title: "欢迎使用 Tie".into(), icon: "👋".into(), parent_id: Some("pg_inbox".into()), sort_key: 0, markdown: "# 欢迎使用 Tie\n\nTie 把 **Notion 的页面树**、**Typora 的写作感** 和 **Obsidian 的链接关系** 放在一起。\n\n## 从这里开始\n\n1. 在左侧创建页面或子页面\n2. 直接用 Markdown 写作\n3. 用标签与链接整理知识\n".into(), tags: vec!["开始".into()], created_at: created.clone(), updated_at: created, deleted_at: None, storage_source_id: storage_source_id.to_owned(), storage_source_ids: vec![storage_source_id.to_owned()] },
  ]
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn ensure_demo(root: &Path, storage_source_id: &str) -> Result<(), String> {
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
