use crate::page::{
    archive_page_revision, normalize_page_sources, page_has_changed, parse_page, read_stored_page,
    remove_page_assets, write_page_meta,
};
use crate::paths::{
    allocate_page_path, allocate_page_path_with_current, find_page_file, page_asset_dir, repair_utf8_mojibake, revision_dir,
    sanitize_asset_name,
    workspace_relative,
};
use tie_common::fs_path::paths_equal;
use tie_common::{Page, PageRevision, StorageSource};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn source_root(sources: &[StorageSource], storage_source_id: &str) -> Result<PathBuf, String> {
    let source = sources
        .iter()
        .find(|item| item.id == storage_source_id)
        .ok_or("页面所属存储源不存在")?;
    Ok(PathBuf::from(&source.path))
}

/// Write a page into a single workspace root (shared by Tauri multi-source and CLI).
pub fn save_page_to_root(
    root: &std::path::Path,
    page: Page,
    expected_updated_at: Option<&str>,
) -> Result<Page, String> {
    let mut page = normalize_page_sources(page);
    page.title = repair_utf8_mojibake(&page.title);
    page.markdown = repair_utf8_mojibake(&page.markdown);
    fs::create_dir_all(root.join("pages")).map_err(|error| error.to_string())?;
    let previous_path = find_page_file(root, &page.id);
    if let Some(path) = &previous_path {
        if let Ok(previous) = read_stored_page(root, path) {
            if let Some(expected) = expected_updated_at {
                if previous.updated_at != expected {
                    return Err("页面文件已在磁盘上被修改，请重新载入后再保存".to_owned());
                }
            }
            if page_has_changed(&previous, &page) {
                archive_page_revision(root, &previous)?;
            }
        }
    }
    let path = allocate_page_path(root, &page.id, &page.title);
    let bytes = page.markdown.as_bytes();
    let unchanged = fs::read(&path).ok().is_some_and(|current| current == bytes);
    if !unchanged {
        fs::write(&path, bytes).map_err(|error| error.to_string())?;
    }
    write_page_meta(root, &page, &workspace_relative(root, &path)?)?;
    if let Some(previous) = previous_path {
        if !paths_equal(&previous, &path) {
            let _ = fs::remove_file(previous);
        }
    }
    Ok(page)
}

/// Rename an existing page file to its title. Does not rewrite content.
pub fn relocate_page_file(root: &std::path::Path, page_id: &str, title: &str) -> Result<(), String> {
    let Some(current) = find_page_file(root, page_id) else {
        return Ok(());
    };
    relocate_page_file_from_path(root, page_id, title, &current).map(|_| ())
}

pub(crate) fn relocate_page_file_from_path(
    root: &std::path::Path,
    page_id: &str,
    title: &str,
    current: &std::path::Path,
) -> Result<PathBuf, String> {
    let target = allocate_page_path_with_current(root, page_id, title, Some(current));
    if paths_equal(current, &target) {
        return Ok(target);
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::rename(current, &target).map_err(|error| format!("无法按标题重命名页面文件：{error}"))?;
    crate::paths::retarget_page_meta(root, page_id, &workspace_relative(root, &target)?)?;
    Ok(target)
}

pub fn save_page(
    sources: &[StorageSource],
    page: Page,
    expected_updated_at: Option<&str>,
    write_source_id: Option<&str>,
) -> Result<Page, String> {
    let page = normalize_page_sources(page);
    let write_id = write_source_id.unwrap_or(page.storage_source_id.as_str());
    let source = sources
        .iter()
        .find(|source| source.id == write_id)
        .ok_or("页面所属存储源不存在")?;
    let root = PathBuf::from(&source.path);
    save_page_to_root(&root, page, expected_updated_at)
}

pub fn list_file_page_assets(page: &Page, sources: &[StorageSource]) -> Result<Vec<String>, String> {
    let root = source_root(sources, &page.storage_source_id)?;
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

pub fn list_page_revisions(
    sources: &[StorageSource],
    page_id: &str,
    storage_source_id: &str,
) -> Result<Vec<PageRevision>, String> {
    let root = source_root(sources, storage_source_id)?;
    list_page_revisions_from_root(&root, page_id)
}

pub(crate) fn list_page_revisions_from_root(
    root: &Path,
    page_id: &str,
) -> Result<Vec<PageRevision>, String> {
    validate_history_component(page_id, "页面 ID")?;
    let directory = revision_dir(root, page_id);
    let mut revisions = Vec::new();
    if !directory.exists() {
        return Ok(revisions);
    }
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if !path.extension().is_some_and(|extension| extension == "md") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or("版本文件名无效")?
            .to_owned();
        validate_history_component(&id, "版本 ID")?;
        let page = parse_revision_file(&path, page_id)?;
        revisions.push(PageRevision {
            id,
            saved_at: page.updated_at,
            title: page.title,
        });
    }
    revisions.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(revisions)
}

pub fn read_page_revision(
    sources: &[StorageSource],
    page: &Page,
    revision_id: &str,
) -> Result<Page, String> {
    let root = source_root(sources, &page.storage_source_id)?;
    read_page_revision_from_root(&root, &page.id, revision_id)
}

pub(crate) fn read_page_revision_from_root(
    root: &Path,
    page_id: &str,
    revision_id: &str,
) -> Result<Page, String> {
    validate_history_component(page_id, "页面 ID")?;
    validate_history_component(revision_id, "版本 ID")?;
    let path = revision_dir(root, page_id).join(format!("{revision_id}.md"));
    parse_revision_file(&path, page_id)
}

fn validate_history_component(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || matches!(value, "." | "..")
        || value.chars().any(|character| matches!(character, '/' | '\\' | ':') || character.is_control())
    {
        return Err(format!("{label} 无效"));
    }
    Ok(())
}

fn parse_revision_file(path: &Path, page_id: &str) -> Result<Page, String> {
    let content = fs::read_to_string(path).map_err(|error| format!("无法读取历史版本：{error}"))?;
    let page = parse_page(&content)?;
    if page.id != page_id {
        return Err("历史版本不属于该页面".to_owned());
    }
    Ok(page)
}

pub fn restore_page_revision(
    sources: &[StorageSource],
    page: Page,
    revision_id: &str,
) -> Result<Page, String> {
    let revision = read_page_revision(sources, &page, revision_id)?;
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
    save_page(sources, restored, None, None)
}

pub fn permanently_delete_pages(sources: &[StorageSource], pages: &[Page]) -> Result<(), String> {
    for page in pages {
        let source = sources
            .iter()
            .find(|source| source.id == page.storage_source_id)
            .ok_or("页面所属存储源不存在")?;
        let root = PathBuf::from(&source.path);
        if let Some(markdown) = find_page_file(&root, &page.id) {
            fs::remove_file(markdown).map_err(|error| format!("无法彻底删除页面：{error}"))?;
        }
        let history = revision_dir(&root, &page.id);
        if history.exists() {
            fs::remove_dir_all(history).map_err(|error| format!("无法移除页面历史：{error}"))?;
        }
        remove_page_assets(&root, &page.id)?;
    }
    Ok(())
}

pub fn save_file_page_asset(
    sources: &[StorageSource],
    page: &Page,
    file_name: &str,
    data: &[u8],
) -> Result<String, String> {
    if data.is_empty() {
        return Err("附件内容为空".to_owned());
    }
    if data.len() > 20 * 1024 * 1024 {
        return Err("附件超过 20 MB".to_owned());
    }
    let root = source_root(sources, &page.storage_source_id)?;
    let asset_name = sanitize_asset_name(file_name)?;
    let directory = page_asset_dir(&root, &page.id);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::write(directory.join(&asset_name), data).map_err(|error| error.to_string())?;
    Ok(asset_name)
}

pub fn read_file_page_asset(
    sources: &[StorageSource],
    page: &Page,
    asset_name: &str,
) -> Result<Vec<u8>, String> {
    let root = source_root(sources, &page.storage_source_id)?;
    let asset_name = sanitize_asset_name(asset_name)?;
    fs::read(page_asset_dir(&root, &page.id).join(asset_name)).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn sample(id: &str, title: &str) -> Page {
        Page {
            id: id.to_owned(),
            title: title.to_owned(),
            icon: String::new(),
            parent_id: None,
            sort_key: 0,
            markdown: format!("# {title}\n"),
            tags: Vec::new(),
            created_at: "2026-01-01T00:00:00.000Z".to_owned(),
            updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
            deleted_at: None,
            storage_source_id: "src".to_owned(),
            storage_source_ids: vec!["src".to_owned()],
        }
    }

    #[test]
    fn duplicate_titles_get_separate_files_and_rename_drops_the_old_name() {
        let root = env::temp_dir().join(format!("tie-page-names-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        save_page_to_root(&root, sample("pg_a", "无标题"), None).unwrap();
        save_page_to_root(&root, sample("pg_b", "无标题"), None).unwrap();
        assert!(root.join("pages").join("无标题.md").is_file());
        assert!(root.join("pages").join("无标题-2.md").is_file());
        save_page_to_root(&root, sample("pg_a", "欢迎使用 Tie"), None).unwrap();
        assert!(root.join("pages").join("欢迎使用 Tie.md").is_file());
        assert!(!root.join("pages").join("无标题.md").exists());
        assert!(root.join("pages").join("无标题-2.md").is_file());
        let first = fs::read_to_string(root.join("pages").join("欢迎使用 Tie.md")).unwrap();
        assert!(first.starts_with("# 欢迎使用 Tie"));
        assert!(!first.contains("tie_version"));
        assert!(root.join(".tie").join("meta").join("pg_a").is_file());
        assert!(find_page_file(&root, "pg_b").is_some());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn saving_a_legacy_page_strips_tie_frontmatter_only() {
        let root = env::temp_dir().join(format!("tie-strip-header-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("pages")).unwrap();
        let legacy = "---\ntie_version: 1\nid: pg_aabbccddeeff0011\nparent_id: \nsort_key: 0\nicon: \ntags: []\ncreated_at: 2026-01-01T00:00:00.000Z\nupdated_at: 2026-01-01T00:00:00.000Z\n---\n\n# 旧页\n\n正文\n";
        fs::write(root.join("pages").join("pg_aabbccddeeff0011.md"), legacy).unwrap();
        let mut page = crate::page::parse_page(legacy).unwrap();
        page.storage_source_id = "src".into();
        save_page_to_root(&root, page, None).unwrap();
        let written = fs::read_to_string(find_page_file(&root, "pg_aabbccddeeff0011").unwrap()).unwrap();
        assert!(!written.contains("tie_version"));
        assert!(written.contains("正文"));
        assert!(!root.join("pages").join("pg_aabbccddeeff0011.md").exists() || !written.starts_with("---"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn history_io_rejects_path_components_and_foreign_page_snapshots() {
        let root = env::temp_dir().join(format!("tie-history-io-{}", crate::page::new_page_id()));
        let sources = vec![StorageSource {
            id: "src".into(), name: "Fixture".into(), kind: "local_folder".into(),
            path: root.to_string_lossy().into_owned(), available: true,
        }];
        let mut current = sample("pg_history_io", "History");
        save_page_to_root(&root, current.clone(), None).unwrap();
        current.markdown.push_str("changed\n");
        save_page_to_root(&root, current.clone(), None).unwrap();
        let revisions = list_page_revisions(&sources, &current.id, "src").unwrap();
        assert_eq!(revisions.len(), 1);
        assert!(!read_page_revision(&sources, &current, &revisions[0].id).unwrap().markdown.contains("changed"));
        for invalid in ["", ".", "..", "../other/123", "/tmp/123", "C:\\history", "other\\123", "nul\0id"] {
            assert!(read_page_revision(&sources, &current, invalid).unwrap_err().contains("版本 ID"));
            assert!(restore_page_revision(&sources, current.clone(), invalid).is_err());
        }
        assert!(list_page_revisions(&sources, "../other", "src").unwrap_err().contains("页面 ID"));
        let foreign = revision_dir(&root, &current.id).join("foreign.md");
        fs::write(&foreign, crate::page::frontmatter(&sample("pg_other", "Other"))).unwrap();
        assert!(read_page_revision(&sources, &current, "foreign").unwrap_err().contains("不属于"));
        assert!(restore_page_revision(&sources, current.clone(), "foreign").unwrap_err().contains("不属于"));
        assert!(list_page_revisions(&sources, &current.id, "src").unwrap_err().contains("不属于"));
        assert_eq!(read_stored_page(&root, &find_page_file(&root, &current.id).unwrap()).unwrap().markdown, current.markdown);
        let _ = fs::remove_dir_all(root);
    }
}

pub fn export_page_markdown(page: &Page, target_path: &str) -> Result<(), String> {
    let path = PathBuf::from(target_path);
    if path.extension().is_none() {
        return Err("导出文件需要使用 .md 扩展名".to_owned());
    }
    fs::write(&path, &page.markdown).map_err(|error| format!("无法导出 Markdown：{error}"))?;
    Ok(())
}
