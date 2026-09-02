use crate::page::{
    archive_page_revision, frontmatter, normalize_page_sources, page_has_changed, parse_page,
    remove_page_assets,
};
use crate::paths::{markdown_path, page_asset_dir, revision_dir, sanitize_asset_name};
use tie_common::{Page, PageRevision, StorageSource};
use std::{fs, path::PathBuf};

pub fn source_root(sources: &[StorageSource], storage_source_id: &str) -> Result<PathBuf, String> {
    let source = sources
        .iter()
        .find(|item| item.id == storage_source_id)
        .ok_or("页面所属存储源不存在")?;
    Ok(PathBuf::from(&source.path))
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
    fs::create_dir_all(root.join("pages")).map_err(|error| error.to_string())?;
    let path = markdown_path(&root, &page.id);
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(previous) = parse_page(&content) {
            if let Some(expected) = expected_updated_at {
                if previous.updated_at != expected {
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
    let source = sources
        .iter()
        .find(|source| source.id == storage_source_id)
        .ok_or("页面所属存储源不存在")?;
    let directory = revision_dir(&PathBuf::from(&source.path), page_id);
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

pub fn read_page_revision(
    sources: &[StorageSource],
    page: &Page,
    revision_id: &str,
) -> Result<Page, String> {
    let source = sources
        .iter()
        .find(|source| source.id == page.storage_source_id)
        .ok_or("页面所属存储源不存在")?;
    let path = revision_dir(&PathBuf::from(&source.path), &page.id)
        .join(format!("{revision_id}.md"));
    let content = fs::read_to_string(path).map_err(|error| format!("无法读取历史版本：{error}"))?;
    parse_page(&content)
}

pub fn restore_page_revision(
    sources: &[StorageSource],
    page: Page,
    revision_id: &str,
) -> Result<Page, String> {
    let source = sources
        .iter()
        .find(|source| source.id == page.storage_source_id)
        .ok_or("页面所属存储源不存在")?;
    let path = revision_dir(&PathBuf::from(&source.path), &page.id)
        .join(format!("{revision_id}.md"));
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
    save_page(sources, restored, None, None)
}

pub fn permanently_delete_pages(sources: &[StorageSource], pages: &[Page]) -> Result<(), String> {
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

pub fn export_page_markdown(page: &Page, target_path: &str) -> Result<(), String> {
    let path = PathBuf::from(target_path);
    if path.extension().is_none() {
        return Err("导出文件需要使用 .md 扩展名".to_owned());
    }
    fs::write(&path, &page.markdown).map_err(|error| format!("无法导出 Markdown：{error}"))?;
    Ok(())
}
