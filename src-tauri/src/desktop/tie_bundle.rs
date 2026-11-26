//! Desktop open/pack/unpack for `.tie` solutions and `.tiez` archives.

use super::{ensure_local_source_at, source_root};
use crate::common::{
    load_settings, load_workspace_snapshot, save_settings, workspace_sources, WorkspaceSnapshot,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tie_storage::local::{
    pack_tiez, resolve_workspace_entry, unpack_tiez, PackReport,
    UnpackReport,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenTieEntryResult {
    snapshot: WorkspaceSnapshot,
    source_id: String,
    created: bool,
    workspace: String,
    solution_name: Option<String>,
    root_page_id: Option<String>,
}

fn apply_source_name(app: &AppHandle, source_id: &str, name: &str) -> Result<(), String> {
    let clean = name.trim();
    if clean.is_empty() || clean.chars().count() > 80 {
        return Ok(());
    }
    let existing = load_settings(app)?;
    let (mut sources, _) = workspace_sources(app)?;
    let Some(source) = sources.iter_mut().find(|s| s.id == source_id) else {
        return Ok(());
    };
    source.name = clean.to_owned();
    save_settings(
        app,
        &crate::common::WorkspaceSettings {
            name: existing.name,
            path: String::new(),
            kind: String::new(),
            sources,
            s3_providers: existing.s3_providers,
        },
    )
}

fn register_workspace_root(
    app: &AppHandle,
    root: &Path,
    preferred_name: Option<&str>,
) -> Result<(String, bool), String> {
    let (source, created) = ensure_local_source_at(app, root.to_path_buf())?;
    if let Some(name) = preferred_name {
        apply_source_name(app, &source.id, name)?;
    }
    Ok((source.id, created))
}

/// Open a `.tie` solution file or a workspace directory containing `pages/`.
#[tauri::command]
pub(crate) fn open_tie_entry(app: AppHandle, path: String) -> Result<OpenTieEntryResult, String> {
    let entry = PathBuf::from(path.trim());
    let (root, solution) = resolve_workspace_entry(&entry)?;
    let root_page_id = solution_root_page(solution.as_ref());
    let name = solution_workspace_name(solution.as_ref());
    let (source_id, created) = register_workspace_root(&app, &root, name)?;
    Ok(OpenTieEntryResult {
        snapshot: load_workspace_snapshot(&app)?,
        source_id,
        created,
        workspace: root.display().to_string(),
        solution_name: name.map(|s| s.to_owned()),
        root_page_id,
    })
}

/// Pack a registered local/smb source into a `.tiez` archive.
#[tauri::command]
pub(crate) fn pack_workspace_tiez(
    app: AppHandle,
    source_id: String,
    out_path: String,
) -> Result<PackReport, String> {
    let root = source_root(&app, &source_id)?;
    let out = PathBuf::from(out_path.trim());
    pack_tiez(&root, &out)
}

/// Unpack a `.tiez` into `out_dir`, register as local source, return workspace snapshot.
#[tauri::command]
pub(crate) fn unpack_tiez_to_dir(
    app: AppHandle,
    archive: String,
    out_dir: String,
) -> Result<OpenTieEntryResult, String> {
    let archive = PathBuf::from(archive.trim());
    let out = PathBuf::from(out_dir.trim());
    let report: UnpackReport = unpack_tiez(&archive, &out)?;
    let (root, solution) = resolve_workspace_entry(&out)?;
    let root_page_id = solution_root_page(solution.as_ref());
    let name = solution_workspace_name(solution.as_ref()).or_else(|| {
        out.file_name()
            .and_then(|n| n.to_str())
            .filter(|s| !s.is_empty())
    });
    let (source_id, created) = register_workspace_root(&app, &root, name)?;
    let _ = report;
    Ok(OpenTieEntryResult {
        snapshot: load_workspace_snapshot(&app)?,
        source_id,
        created,
        workspace: root.display().to_string(),
        solution_name: name.map(|s| s.to_owned()),
        root_page_id,
    })
}

fn solution_root_page(solution: Option<&tie_storage::local::TieSolution>) -> Option<String> {
    let id = solution?.root_page.trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_owned())
    }
}

fn solution_workspace_name(solution: Option<&tie_storage::local::TieSolution>) -> Option<&str> {
    let solution = solution?;
    if !solution.root_page.trim().is_empty() {
        return None;
    }
    let name = solution.name.trim();
    if name.is_empty() { None } else { Some(name) }
}

/// Ensure a `.tie` solution file exists for a source (for export/open convenience).
#[tauri::command]
pub(crate) fn ensure_source_solution(
    app: AppHandle,
    source_id: String,
    name: Option<String>,
) -> Result<String, String> {
    let (sources, _) = workspace_sources(&app)?;
    let source = sources
        .iter()
        .find(|s| s.id == source_id)
        .ok_or("存储源不存在")?;
    let root = PathBuf::from(&source.path);
    let ws = tie_storage::local::LocalWorkspace::open(&root, Some(source.id.as_str()))?;
    let pages = ws.load_all(true)?;
    let tie_pages: Vec<tie_storage::local::RootTiePage> = pages
        .iter()
        .map(|page| tie_storage::local::RootTiePage {
            id: page.id.clone(),
            title: page.title.clone(),
            created_at: page.created_at.clone(),
            is_root: page.deleted_at.is_none()
                && page.parent_id.as_deref().unwrap_or("").is_empty(),
        })
        .collect();
    tie_storage::local::sync_root_tie_files(&root, &source.id, &tie_pages)?;
    let path = tie_storage::local::find_solution_file(&root)
        .map(|(path, _)| path)
        .unwrap_or(root);
    let _ = name;
    Ok(path.display().to_string())
}
