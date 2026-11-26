use crate::paths::{
    allocate_page_path, page_asset_dir, page_meta_path, resolve_workspace_file, revision_dir,
    workspace_relative,
};
use tie_common::fs_path::{canonicalize, paths_equal};
use tie_common::{Page, MAX_PAGE_REVISIONS};
use std::{collections::HashMap, fs, path::Path};
use std::time::{SystemTime, UNIX_EPOCH};

pub const ENCRYPTED_MARKDOWN_PREFIX: &str = "-----BEGIN TIE ENCRYPTED MARKDOWN-----";

/// Recognize the wrapper even when its payload is damaged; storage never interprets it as Markdown.
pub fn is_encrypted_markdown(markdown: &str) -> bool {
    markdown.trim_start_matches('\u{feff}').starts_with(ENCRYPTED_MARKDOWN_PREFIX)
}

pub fn revision_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos}")
}

pub fn page_has_changed(before: &Page, after: &Page) -> bool {
    before.created_at != after.created_at
        || before.title != after.title
        || before.icon != after.icon
        || before.parent_id != after.parent_id
        || before.sort_key != after.sort_key
        || before.markdown != after.markdown
        || before.tags != after.tags
        || before.deleted_at != after.deleted_at
}

pub fn archive_page_revision(root: &Path, page: &Page) -> Result<(), String> {
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

pub fn copy_page_assets(source_root: &Path, target_root: &Path, page_id: &str) -> Result<(), String> {
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

pub fn remove_page_assets(root: &Path, page_id: &str) -> Result<(), String> {
    let directory = page_asset_dir(root, page_id);
    if directory.exists() {
        fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn copy_page_history(source_root: &Path, target_root: &Path, page_id: &str) -> Result<(), String> {
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

pub fn frontmatter(page: &Page) -> String {
    // 只给历史版本和远程对象用。工作区里的 pages/*.md 写正文，元数据在 .tie/meta。
    let page = normalize_page_sources(page.clone());
    let parent = page.parent_id.clone().unwrap_or_default();
    let tags = page.tags.join(", ");
    let deleted = page
        .deleted_at
        .as_ref()
        .map(|value| format!("deleted_at: {value}\n"))
        .unwrap_or_default();
    let icon = page.icon.replace(['\n', '\r'], "");
    let title = page.title.replace(['\n', '\r'], "");
    format!(
        "---\ntie_version: 1\nid: {}\nparent_id: {}\nsort_key: {}\nicon: {}\ntitle: {}\ntags: [{}]\ncreated_at: {}\nupdated_at: {}\n{}---\n\n{}",
        page.id, parent, page.sort_key, icon, title, tags, page.created_at, page.updated_at, deleted, page.markdown
    )
}

#[derive(Clone)]
struct PageMeta {
    id: String,
    file: String,
    parent_id: String,
    sort_key: i64,
    icon: String,
    title: String,
    tags: Vec<String>,
    created_at: String,
    updated_at: String,
    deleted_at: String,
}

fn meta_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// Tie 头部只认我们自己的标记。其他 `---` 块（Obsidian 等）留在正文里。
pub fn is_tie_document(content: &str) -> bool {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let normalized = content.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return false;
    };
    let Some((block, _)) = rest.split_once("\n---\n") else {
        return false;
    };
    block.lines().any(|line| {
        let Some((key, value)) = line.trim().split_once(':') else {
            return false;
        };
        match key.trim() {
            "tie_version" => !value.trim().is_empty(),
            "id" => value.trim().starts_with("pg_"),
            _ => false,
        }
    })
}

fn heading_title(markdown: &str) -> Option<String> {
    if is_encrypted_markdown(markdown) {
        return None;
    }
    markdown.lines().find_map(|line| {
        let title = line.trim_end_matches('\r').strip_prefix("# ")?.trim();
        if title.is_empty() {
            None
        } else {
            Some(title.to_owned())
        }
    })
}

fn unix_secs_to_iso(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let hour = tod / 3600;
    let minute = (tod % 3600) / 60;
    let second = tod % 60;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let mut year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    unix_secs_to_iso(secs)
}

fn parse_meta(text: &str) -> Option<PageMeta> {
    let lines: Vec<&str> = text.lines().collect();
    let id = value(&lines, "id");
    let file = value(&lines, "file");
    if !id.starts_with("pg_") || file.is_empty() {
        return None;
    }
    let tags = value(&lines, "tags")
        .trim_matches(['[', ']'])
        .split(',')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(str::to_owned)
        .collect();
    Some(PageMeta {
        id,
        file,
        parent_id: value(&lines, "parent_id"),
        sort_key: value(&lines, "sort_key").parse().unwrap_or(0),
        icon: value(&lines, "icon"),
        title: value(&lines, "title"),
        tags,
        created_at: value(&lines, "created_at"),
        updated_at: value(&lines, "updated_at"),
        deleted_at: value(&lines, "deleted_at"),
    })
}

fn find_meta_for_file(root: &Path, md_path: &Path) -> Option<PageMeta> {
    let entries = fs::read_dir(root.join(".tie").join("meta")).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Some(meta) = parse_meta(&text) else {
            continue;
        };
        let Some(resolved) = resolve_workspace_file(root, &meta.file) else {
            continue;
        };
        if paths_equal(&resolved, md_path) {
            return Some(meta);
        }
    }
    None
}

pub(crate) struct PageMetaIndex(HashMap<String, PageMeta>);

impl PageMetaIndex {
    pub(crate) fn load(root: &Path) -> Self {
        let mut by_file = HashMap::new();
        if let Ok(entries) = fs::read_dir(root.join(".tie").join("meta")) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let Ok(text) = fs::read_to_string(&path) else {
                    continue;
                };
                let Some(meta) = parse_meta(&text) else {
                    continue;
                };
                let Some(resolved) = resolve_workspace_file(root, &meta.file) else {
                    continue;
                };
                // Match find_meta_for_file: the first valid sidecar for a file wins.
                by_file.entry(Self::file_key(&resolved)).or_insert(meta);
            }
        }
        Self(by_file)
    }

    fn file_key(path: &Path) -> String {
        let path = canonicalize(path);
        let text = path.to_string_lossy();
        #[cfg(windows)]
        {
            text.replace('/', "\\").to_ascii_lowercase()
        }
        #[cfg(not(windows))]
        {
            text.into_owned()
        }
    }

    fn get(&self, path: &Path) -> Option<PageMeta> {
        self.0.get(&Self::file_key(path)).cloned()
    }
}

fn page_from_meta(meta: PageMeta, markdown: String, source_id: &str) -> Page {
    let fallback = if meta.title.trim().is_empty() {
        "无标题"
    } else {
        meta.title.trim()
    };
    let title = heading_title(&markdown).unwrap_or_else(|| fallback.to_owned());
    normalize_page_sources(Page {
        id: meta.id,
        title,
        icon: meta.icon,
        parent_id: (!meta.parent_id.is_empty()).then_some(meta.parent_id),
        sort_key: meta.sort_key,
        markdown,
        tags: meta.tags,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        deleted_at: (!meta.deleted_at.is_empty()).then_some(meta.deleted_at),
        storage_source_id: source_id.to_owned(),
        storage_source_ids: if source_id.is_empty() {
            Vec::new()
        } else {
            vec![source_id.to_owned()]
        },
    })
}

pub fn write_page_meta(root: &Path, page: &Page, relative_file: &str) -> Result<(), String> {
    if !meta_id_ok(&page.id) {
        return Err(format!("页面 id 无效：{}", page.id));
    }
    if relative_file.is_empty()
        || relative_file.contains("..")
        || relative_file.contains(':')
        || relative_file.contains('\\')
    {
        return Err("页面相对路径无效".to_owned());
    }
    let path = page_meta_path(root, &page.id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let parent_id = page.parent_id.clone().unwrap_or_default();
    let deleted = page.deleted_at.clone().unwrap_or_default();
    let icon = page.icon.replace(['\n', '\r'], "");
    let title = page.title.replace(['\n', '\r'], "");
    let text = format!(
        "tie_version: 1\nid: {}\nfile: {}\nparent_id: {}\nsort_key: {}\nicon: {}\ntitle: {}\ntags: [{}]\ncreated_at: {}\nupdated_at: {}\ndeleted_at: {}\n",
        page.id,
        relative_file,
        parent_id,
        page.sort_key,
        icon,
        title,
        page.tags.join(", "),
        page.created_at,
        page.updated_at,
        deleted
    );
    fs::write(path, text).map_err(|error| error.to_string())
}

pub fn remove_page_meta(root: &Path, page_id: &str) {
    if meta_id_ok(page_id) {
        let _ = fs::remove_file(page_meta_path(root, page_id));
    }
}

/// Read a page file. Tie frontmatter still parses; a plain file needs its sidecar.
pub fn read_stored_page(root: &Path, path: &Path) -> Result<Page, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    if is_tie_document(&content) {
        return parse_page(&content);
    }
    let meta = find_meta_for_file(root, path).ok_or("普通 Markdown 缺少 .tie/meta 登记")?;
    Ok(page_from_meta(meta, content, ""))
}

/// Open a markdown file. Plain files get a sidecar and the bytes on disk stay as they are.
pub fn open_or_adopt(root: &Path, path: &Path, source_id: &str) -> Result<Page, String> {
    open_or_adopt_with_meta_index(root, path, source_id, None)
}

pub(crate) fn open_or_adopt_with_meta_index(
    root: &Path,
    path: &Path,
    source_id: &str,
    index: Option<&mut PageMetaIndex>,
) -> Result<Page, String> {
    let content = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if is_tie_document(&content) {
        return parse_page(&content).map_err(|error| format!("{}: {error}", path.display()));
    }
    let meta = match index.as_deref() {
        Some(index) => index.get(path),
        None => find_meta_for_file(root, path),
    };
    if let Some(meta) = meta {
        return Ok(page_from_meta(meta, content, source_id));
    }
    let relative = workspace_relative(root, path)?;
    let now = now_iso();
    let title = heading_title(&content).unwrap_or_else(|| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|stem| !stem.is_empty())
            .unwrap_or("无标题")
            .to_owned()
    });
    let meta = PageMeta {
        id: new_page_id(),
        file: relative.clone(),
        parent_id: String::new(),
        sort_key: 0,
        icon: String::new(),
        title,
        tags: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
        deleted_at: String::new(),
    };
    let page = page_from_meta(meta.clone(), content, source_id);
    write_page_meta(root, &page, &relative)?;
    if let Some(index) = index {
        index.0.entry(PageMetaIndex::file_key(path)).or_insert(meta);
    }
    Ok(page)
}

fn parse_source_ids(raw: &str) -> Vec<String> {
    raw.trim_matches(['[', ']'])
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect()
}

pub fn merge_loaded_pages(pages: Vec<Page>) -> Vec<Page> {
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

pub fn normalize_page_sources(mut page: Page) -> Page {
    if page.storage_source_ids.is_empty() {
        if !page.storage_source_id.is_empty() {
            page.storage_source_ids = vec![page.storage_source_id.clone()];
        }
    } else if !page.storage_source_id.is_empty()
        && !page
            .storage_source_ids
            .iter()
            .any(|id| id == &page.storage_source_id)
    {
        page.storage_source_ids.insert(0, page.storage_source_id.clone());
    } else if page.storage_source_id.is_empty() {
        if let Some(first) = page.storage_source_ids.first().cloned() {
            page.storage_source_id = first;
        }
    }
    page
}


fn value(lines: &[&str], key: &str) -> String {
    lines
        .iter()
        .find_map(|line| line.strip_prefix(&format!("{key}: ")).map(str::to_owned))
        .unwrap_or_default()
}

pub fn new_page_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mixed = nanos.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!("pg_{:016x}", (mixed as u64) ^ ((mixed >> 64) as u64))
}

pub fn parse_page(content: &str) -> Result<Page, String> {
    // Accept CRLF checkouts / editors on Windows; writers still emit LF.
    let original = content;
    let content = content.replace("\r\n", "\n");
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
    let mut markdown = markdown.trim_start_matches('\n').to_owned();
    if is_encrypted_markdown(&markdown) {
        let mut offset = 0;
        for (index, line) in original.split_inclusive('\n').enumerate() {
            offset += line.len();
            if index > 0 && line.trim_end_matches(['\r', '\n']) == "---" {
                markdown = original[offset..].trim_start_matches(['\r', '\n']).to_owned();
                break;
            }
        }
    }
    let fallback_title = value(&lines, "title");
    let title = heading_title(&markdown)
        .or_else(|| (!fallback_title.trim().is_empty()).then_some(fallback_title))
        .unwrap_or_else(|| "无标题".to_owned());
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

pub fn demo_pages(storage_source_id: &str) -> Vec<Page> {
    let created = "2026-08-27T00:00:00.000Z".to_owned();
    vec![Page {
        id: "pg_welcome".into(),
        title: "欢迎使用 Tie".into(),
        icon: "👋".into(),
        parent_id: None,
        sort_key: 0,
        markdown: "# 欢迎使用 Tie\n\nTie 把 **Notion 的页面树**、**Typora 的写作感** 和 **Obsidian 的链接关系** 放在一起。\n\n## 从这里开始\n\n1. 在左侧创建页面或子页面\n2. 直接用 Markdown 写作\n3. 用标签与链接整理知识\n".into(),
        tags: vec!["开始".into()],
        created_at: created.clone(),
        updated_at: created,
        deleted_at: None,
        storage_source_id: storage_source_id.to_owned(),
        storage_source_ids: vec![storage_source_id.to_owned()],
    }]
}

pub fn ensure_demo(root: &Path, storage_source_id: &str) -> Result<(), String> {
    if fs::read_dir(root.join("pages"))
        .map_err(|error| error.to_string())?
        .next()
        .is_none()
    {
        for page in demo_pages(storage_source_id) {
            let path = allocate_page_path(root, &page.id, &page.title);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&path, &page.markdown).map_err(|error| error.to_string())?;
            write_page_meta(root, &page, &workspace_relative(root, &path)?)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("testdata/page-format")
            .join(name);
        fs::read_to_string(path).expect("fixture")
    }

    fn assert_roundtrip(name: &str) {
        let raw = fixture(name);
        let page = parse_page(&raw).expect("parse");
        let again = parse_page(&frontmatter(&page)).expect("reparse");
        assert_eq!(page.id, again.id);
        assert_eq!(page.title, again.title);
        assert_eq!(page.icon, again.icon);
        assert_eq!(page.parent_id, again.parent_id);
        assert_eq!(page.sort_key, again.sort_key);
        assert_eq!(page.tags, again.tags);
        assert_eq!(page.created_at, again.created_at);
        assert_eq!(page.updated_at, again.updated_at);
        assert_eq!(page.deleted_at, again.deleted_at);
        assert_eq!(page.markdown.trim(), again.markdown.trim());
        // 新写入不再持久化 storage_source_*；内存里的绑定由应用层维护。
        assert!(again.storage_source_id.is_empty());
        assert!(again.storage_source_ids.is_empty() || again.storage_source_ids.iter().all(|id| id.is_empty()));
    }

    #[test]
    fn frontmatter_omits_storage_source_fields() {
        let page = parse_page(&fixture("full.md")).unwrap();
        assert!(!page.storage_source_id.is_empty());
        let raw = frontmatter(&page);
        assert!(!raw.contains("storage_source_id"));
        assert!(!raw.contains("storage_source_ids"));
    }

    #[test]
    fn golden_minimal_roundtrip() {
        assert_roundtrip("minimal.md");
    }

    #[test]
    fn golden_full_roundtrip() {
        let page = parse_page(&fixture("full.md")).unwrap();
        assert_eq!(page.title, "完整页面");
        assert_eq!(page.parent_id.as_deref(), Some("pg_0123456789abcdef"));
        assert_eq!(page.tags, vec!["memory".to_owned(), "decision".to_owned()]);
        assert_eq!(page.storage_source_ids.len(), 2);
        assert_roundtrip("full.md");
    }

    #[test]
    fn golden_deleted_roundtrip() {
        let page = parse_page(&fixture("deleted.md")).unwrap();
        assert!(page.deleted_at.is_some());
        assert_roundtrip("deleted.md");
    }

    #[test]
    fn unix_epoch_formats_as_iso() {
        assert_eq!(unix_secs_to_iso(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn plain_markdown_and_foreign_yaml_stay_byte_for_byte() {
        let root = std::env::temp_dir().join(format!("tie-plain-md-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let pages = root.join("pages");
        fs::create_dir_all(&pages).unwrap();
        let original = "---\r\ntitle: 笔记\r\naliases: [a]\r\n---\r\n\r\n正文保持原样\r\n";
        let file = pages.join("note.md");
        fs::write(&file, original).unwrap();
        assert!(!is_tie_document(original));
        let page = open_or_adopt(&root, &file, "src").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), original);
        assert_eq!(page.markdown, original);
        assert_eq!(page.title, "note");
        assert!(page.id.starts_with("pg_"));
        assert!(page_meta_path(&root, &page.id).is_file());
        let again = open_or_adopt(&root, &file, "src").unwrap();
        assert_eq!(again.id, page.id);
        assert_eq!(fs::read_to_string(&file).unwrap(), original);
        let _ = fs::remove_dir_all(&root);
    }
}
