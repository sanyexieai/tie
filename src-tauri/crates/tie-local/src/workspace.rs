use crate::io::relocate_page_file;
use crate::page::{ensure_demo, merge_loaded_pages, normalize_page_sources, open_or_adopt};
use crate::paths::default_workspace_root;
use crate::settings::{load, save, source_from_path, workspace_sources};
use crate::solution::{sync_root_tie_files, RootTiePage};
use tie_common::fs_path;
use tie_common::{StorageSource, Workspace, WorkspaceSettings, WorkspaceSnapshot};
use std::{fs, path::PathBuf};

pub fn load_file_workspace(
    data_dir: &std::path::Path,
    workspace_id: &str,
) -> Result<WorkspaceSnapshot, String> {
    let settings = load(data_dir)?;
    let default_root = default_workspace_root(data_dir);
    let (mut sources, is_default_source) = workspace_sources(&settings, &default_root);
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
        let mut located = Vec::new();
        let mut tie_pages = Vec::new();
        for entry in fs::read_dir(&pages_dir).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            if path.extension().is_some_and(|extension| extension == "md") {
                let mut page = open_or_adopt(&root, &path, &source.id)?;
                if page.storage_source_id.is_empty() {
                    page.storage_source_id = source.id.clone();
                }
                if !page.storage_source_ids.iter().any(|id| id == &source.id) {
                    page.storage_source_ids.push(source.id.clone());
                }
                located.push((page.id.clone(), page.title.clone(), page.created_at.clone()));
                tie_pages.push(RootTiePage {
                    id: page.id.clone(),
                    title: page.title.clone(),
                    created_at: page.created_at.clone(),
                    is_root: page.deleted_at.is_none()
                        && page.parent_id.as_deref().unwrap_or("").is_empty(),
                });
                pages.push(normalize_page_sources(page));
            }
        }
        located.sort_by(|a, b| a.2.cmp(&b.2).then_with(|| a.0.cmp(&b.0)));
        for (id, title, _) in located {
            let _ = relocate_page_file(&root, &id, &title);
        }
        let _ = sync_root_tie_files(&root, &source.id, &tie_pages);
    }
    Ok(WorkspaceSnapshot {
        workspace: Workspace {
            id: workspace_id.to_owned(),
            name: if settings.name.trim().is_empty() {
                "我的知识库".to_owned()
            } else {
                settings.name
            },
            sources,
        },
        pages: merge_loaded_pages(pages),
    })
}

pub fn resolve_directory_path(path: &str) -> Result<PathBuf, String> {
    let path_buf = PathBuf::from(path);
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        match path_buf.canonicalize() {
            Ok(root) if root.is_dir() => Ok(fs_path::strip_extended_length_prefix(&root)),
            Ok(_) => Err("所选路径不是目录".to_owned()),
            Err(_) if path_buf.is_dir() => Ok(fs_path::strip_extended_length_prefix(&path_buf)),
            Err(error) => Err(format!("无法打开所选目录：{error}")),
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let root = path_buf
            .canonicalize()
            .map_err(|error| format!("无法打开所选目录：{error}"))?;
        if !root.is_dir() {
            return Err("所选路径不是目录".to_owned());
        }
        Ok(fs_path::strip_extended_length_prefix(&root))
    }
}

pub fn register_storage_source(
    data_dir: &std::path::Path,
    root: PathBuf,
    kind: String,
) -> Result<Vec<StorageSource>, String> {
    if !root.is_dir() {
        return Err("所选路径不是目录".to_owned());
    }
    if !matches!(kind.as_str(), "local" | "smb") {
        return Err("不支持的存储源类型".to_owned());
    }
    fs::create_dir_all(root.join("pages")).map_err(|error| error.to_string())?;

    let existing_settings = load(data_dir)?;
    let default_root = default_workspace_root(data_dir);
    let (mut sources, _) = workspace_sources(&existing_settings, &default_root);
    let source = source_from_path(root, kind);
    if !sources.iter().any(|item| item.id == source.id) {
        sources.push(source);
    }
    let settings = WorkspaceSettings {
        name: existing_settings.name,
        path: String::new(),
        kind: String::new(),
        sources: sources.clone(),
        s3_providers: existing_settings.s3_providers,
    };
    save(data_dir, &settings)?;
    Ok(sources)
}
