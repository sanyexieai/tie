pub(crate) mod backend_session;
pub(crate) mod backend_sync;
pub(crate) mod git_sync;
pub(crate) mod tie_bundle;

use crate::common::{
    app_data_dir, copy_page_assets, copy_page_history, find_page_file, load_settings,
    is_tie_document, normalize_page_sources, open_or_adopt, page_asset_dir, parse_page,
    remove_page_assets, revision_dir, sanitize_asset_name, save_page_to_root, save_settings,
    source_from_path, workspace_sources, Page,
    StorageSource,
    WorkspaceSettings, WorkspaceSnapshot,
};
use crate::s3::s3_client_for_app;
use minio::s3::{builders::ObjectContent, types::S3Api};
use serde::Serialize;
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use tie_storage::local::load_file_workspace;
use tie_storage::s3::{
    list_s3_object_keys, s3_asset_object, s3_asset_prefix, s3_history_object, s3_history_prefix,
    trim_s3_history, S3Connection,
};

pub(crate) fn source_root(app: &AppHandle, storage_source_id: &str) -> Result<PathBuf, String> {
    let (sources, _) = workspace_sources(app)?;
    let source = sources
        .iter()
        .find(|item| item.id == storage_source_id)
        .ok_or("页面所属存储源不存在")?;
    Ok(PathBuf::from(&source.path))
}

fn imported_page_id(path: &Path, target_source_id: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    target_source_id.hash(&mut hasher);
    format!("pg_import_{:016x}", hasher.finish())
}

fn importable_page(content: String, fallback_title: String) -> (String, String, Vec<String>) {
    if is_tie_document(&content) {
        if let Ok(page) = parse_page(&content) {
            return (page.title, page.markdown, page.tags);
        }
    }
    let title = content
        .lines()
        .find_map(|line| line.trim_end_matches('\r').strip_prefix("# "))
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or(&fallback_title)
        .to_owned();
    (title, content, Vec::new())
}

struct ImportCandidate {
    page_id: String,
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
        let root = tie_storage::fs_path::strip_extended_length_prefix(&root);
        let file = tie_storage::fs_path::canonicalize(file);
        tie_storage::fs_path::is_under_root(&file, &root)
    })
}

pub(crate) fn ensure_local_source_at(
    app: &AppHandle,
    root: PathBuf,
) -> Result<(StorageSource, bool), String> {
    let root = root
        .canonicalize()
        .map(|path| tie_storage::fs_path::strip_extended_length_prefix(&path))
        .map_err(|error| format!("无法打开工作区目录：{error}"))?;
    if !root.is_dir() {
        return Err("工作区路径不是目录".to_owned());
    }
    fs::create_dir_all(root.join("pages")).map_err(|error| error.to_string())?;

    let existing_settings = load_settings(app)?;
    let (mut sources, _) = workspace_sources(app)?;
    if let Some(existing) = sources
        .iter()
        .find(|source| tie_storage::fs_path::paths_equal(Path::new(&source.path), &root))
    {
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

fn existing_page_in_workspace(root: &Path, file: &Path, source_id: &str) -> Option<String> {
    let pages_dir = root.join("pages");
    let canon_file = tie_storage::fs_path::canonicalize(file);
    let canon_pages = tie_storage::fs_path::canonicalize(&pages_dir);
    if !tie_storage::fs_path::is_under_root(&canon_file, &canon_pages) {
        return None;
    }
    // 已经在工作区里的原文只登记元数据，不另存一份、不改字节。
    open_or_adopt(root, file, source_id).ok().map(|page| page.id)
}

fn import_single_markdown_file(
    root: &Path,
    source_id: &str,
    file: &Path,
    created_at: &str,
) -> Result<String, String> {
    if let Some(existing_id) = existing_page_in_workspace(root, file, source_id) {
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
    if find_page_file(root, &page_id).is_some() {
        return Ok(page_id);
    }

    let content = fs::read_to_string(file).map_err(|error| error.to_string())?;
    let fallback_title = file
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("打开的页面")
        .to_owned();
    let parsed = if is_tie_document(&content) {
        parse_page(&content).ok()
    } else {
        None
    };
    let (title, icon, markdown, tags, parent_id, page_sort_key) = if let Some(original) = parsed {
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
    save_page_to_root(root, page, None)?;
    Ok(page_id)
}

#[derive(serde::Deserialize)]
pub(crate) struct ExportAssetPayload {
    name: String,
    data: Vec<u8>,
}

#[tauri::command]
pub(crate) fn export_page_closure(
    app: AppHandle,
    page_id_or_title: String,
    source_id: String,
    out_dir: String,
    depth: Option<usize>,
    with_children: Option<bool>,
) -> Result<serde_json::Value, String> {
    let root = source_root(&app, &source_id)?;
    let ws = tie_storage::local::LocalWorkspace::open(&root, Some(source_id.as_str()))?;
    let summary = ws.export_closure(
        &page_id_or_title,
        &tie_storage::local::ExportOptions {
            depth: depth.unwrap_or(2),
            with_children: with_children.unwrap_or(true),
            out: Some(PathBuf::from(out_dir)),
        },
    )?;
    serde_json::to_value(summary).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn export_page_markdown_bundle(
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
    fs::create_dir_all(&assets_dir).map_err(|error| format!("无法创建附件目录：{error}"))?;
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
pub(crate) fn transfer_page_storage(
    app: AppHandle,
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
    let source_path = find_page_file(&source_root, &page.id)
        .ok_or_else(|| "原页面文件不存在，无法迁移".to_owned())?;
    let target_root = PathBuf::from(&target.path);
    fs::create_dir_all(target_root.join("pages")).map_err(|error| error.to_string())?;
    if find_page_file(&target_root, &page.id).is_some() {
        return Err("目标存储源中已存在相同页面 ID，无法迁移".to_owned());
    }
    let transferred = normalize_page_sources(Page {
        storage_source_id: target_source_id.clone(),
        storage_source_ids: vec![target_source_id],
        ..page
    });
    let target_path = match save_page_to_root(&target_root, transferred.clone(), None) {
        Ok(_) => find_page_file(&target_root, &transferred.id),
        Err(error) => return Err(error),
    };
    if let Err(error) = copy_page_history(&source_root, &target_root, &transferred.id) {
        if let Some(path) = &target_path {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }
    if let Err(error) = copy_page_assets(&source_root, &target_root, &transferred.id) {
        if let Some(path) = &target_path {
            let _ = fs::remove_file(path);
        }
        let _ = fs::remove_dir_all(revision_dir(&target_root, &transferred.id));
        let _ = remove_page_assets(&target_root, &transferred.id);
        return Err(error);
    }
    if let Err(error) = fs::remove_file(source_path) {
        if let Some(path) = &target_path {
            let _ = fs::remove_file(path);
        }
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

#[tauri::command]
pub(crate) fn import_markdown_files(
    app: AppHandle,
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
            .map(|path| tie_storage::fs_path::strip_extended_length_prefix(&path))
            .map_err(|error| format!("无法读取导入文件：{error}"))?;
        if !path.is_file()
            || !path.extension().is_some_and(|extension| {
                extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
            })
        {
            continue;
        }
        if existing_page_in_workspace(&target_root, &path, &target_source_id).is_some() {
            continue;
        }
        let page_id = imported_page_id(&path, &target_source_id);
        let destination_exists = find_page_file(&target_root, &page_id).is_some();
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let fallback_title = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("导入的页面")
            .to_owned();
        let original_page = if is_tie_document(&content) {
            parse_page(&content).ok()
        } else {
            None
        };
        if let Some(page) = &original_page {
            if !page.id.is_empty() {
                imported_ids.insert(page.id.clone(), page_id.clone());
            }
        }
        imports.push(ImportCandidate {
            page_id,
            destination_exists,
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
        save_page_to_root(&target_root, page, None)?;
    }
    load_file_workspace(&app_data_dir(&app)?, "tie-workspace")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenMarkdownFilesResult {
    snapshot: WorkspaceSnapshot,
    opened_page_ids: Vec<String>,
    created_source_ids: Vec<String>,
}

#[tauri::command]
pub(crate) fn open_markdown_files(
    app: AppHandle,
    paths: Vec<String>,
    created_at: String,
) -> Result<OpenMarkdownFilesResult, String> {
    let mut opened_page_ids = Vec::new();
    let mut created_source_ids = Vec::new();

    for raw_path in paths {
        let file = PathBuf::from(raw_path.trim())
            .canonicalize()
            .map(|path| tie_storage::fs_path::strip_extended_length_prefix(&path))
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

        let page_id =
            import_single_markdown_file(Path::new(&source.path), &source.id, &file, &created_at)?;
        if !opened_page_ids.contains(&page_id) {
            opened_page_ids.push(page_id);
        }
    }

    if opened_page_ids.is_empty() {
        return Err("未选择有效的 Markdown 文件".to_owned());
    }

    Ok(OpenMarkdownFilesResult {
        snapshot: load_file_workspace(&app_data_dir(&app)?, "tie-workspace")?,
        opened_page_ids,
        created_source_ids,
    })
}

fn file_source_root(app: &AppHandle, source_id: &str) -> Result<PathBuf, String> {
    let (sources, _) = workspace_sources(app)?;
    let source = sources
        .iter()
        .find(|source| source.id == source_id)
        .ok_or("存储源不存在")?;
    Ok(PathBuf::from(&source.path))
}

#[tauri::command]
pub(crate) async fn copy_file_history_to_s3(
    app: AppHandle,
    page_id: String,
    file_source_id: String,
    connection: S3Connection,
) -> Result<(), String> {
    let root = file_source_root(&app, &file_source_id)?;
    let source_directory = revision_dir(&root, &page_id);
    if !source_directory.exists() {
        return Ok(());
    }
    let (client, bucket) = s3_client_for_app(&app, &connection)?;
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
        client
            .put_object_content(
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
pub(crate) async fn copy_s3_history_to_file(
    app: AppHandle,
    connection: S3Connection,
    page_id: String,
    file_source_id: String,
) -> Result<(), String> {
    let root = file_source_root(&app, &file_source_id)?;
    let target_directory = revision_dir(&root, &page_id);
    if target_directory.exists() {
        return Err("目标存储源中已存在该页面的历史记录，无法迁移".to_owned());
    }
    let (client, bucket) = s3_client_for_app(&app, &connection)?;
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
        let response = client
            .get_object(bucket.clone(), key)
            .map_err(|error| format!("无法读取 S3 历史版本：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法下载 S3 历史版本：{error}"))?;
        let content = String::from_utf8(
            response
                .into_bytes()
                .await
                .map_err(|error| format!("无法读取 S3 历史版本内容：{error}"))?
                .to_vec(),
        )
        .map_err(|_| "S3 历史版本不是 UTF-8 Markdown 文件".to_owned())?;
        fs::write(target_directory.join(format!("{revision_id}.md")), content)
            .map_err(|error| format!("无法写入本地历史版本：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn copy_file_assets_to_s3(
    app: AppHandle,
    page_id: String,
    file_source_id: String,
    connection: S3Connection,
) -> Result<(), String> {
    let root = file_source_root(&app, &file_source_id)?;
    let source_directory = page_asset_dir(&root, &page_id);
    if !source_directory.exists() {
        return Ok(());
    }
    let (client, bucket) = s3_client_for_app(&app, &connection)?;
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
        client
            .put_object_content(
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
pub(crate) async fn copy_s3_assets_to_file(
    app: AppHandle,
    connection: S3Connection,
    page_id: String,
    file_source_id: String,
) -> Result<(), String> {
    let root = file_source_root(&app, &file_source_id)?;
    let target_directory = page_asset_dir(&root, &page_id);
    let (client, bucket) = s3_client_for_app(&app, &connection)?;
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
        let response = client
            .get_object(bucket.clone(), key)
            .map_err(|error| format!("无法读取 S3 附件：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法下载 S3 附件：{error}"))?;
        let data = response
            .into_bytes()
            .await
            .map_err(|error| format!("无法读取 S3 附件内容：{error}"))?;
        fs::write(target_directory.join(&sanitized), data.to_vec())
            .map_err(|error| format!("无法写入本地附件：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn copy_page_sidecars(
    app: AppHandle,
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
