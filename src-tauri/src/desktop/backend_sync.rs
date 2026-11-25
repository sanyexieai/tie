use tauri::AppHandle;
use tie_cli::backend_sync::{self, BackendSyncReport};

use super::source_root;

fn open_workspace(app: &AppHandle, source_id: &str) -> Result<tie_storage::local::LocalWorkspace, String> {
    let root = source_root(app, source_id)?;
    tie_storage::local::LocalWorkspace::open(&root, Some(source_id))
}

#[tauri::command]
pub(crate) fn backend_sync_cursor(app: AppHandle, source_id: String) -> Result<serde_json::Value, String> {
    let ws = open_workspace(&app, &source_id)?;
    backend_sync::read_sync_cursor(ws.root())
}

#[tauri::command]
pub(crate) fn sync_backend_workspace(
    app: AppHandle,
    source_id: String,
    url: String,
    workspace_id: String,
) -> Result<BackendSyncReport, String> {
    let ws = open_workspace(&app, &source_id)?;
    backend_sync::align(&ws, &url, &workspace_id)
}

#[tauri::command]
pub(crate) fn list_page_reviews(app: AppHandle, source_id: String, page_id: String) -> Result<serde_json::Value, String> {
    let ws = open_workspace(&app, &source_id)?;
    Ok(backend_sync::read_review_file(ws.root(), &page_id))
}

#[tauri::command]
pub(crate) fn add_page_opinion(
    app: AppHandle,
    source_id: String,
    page_id: String,
    id: String,
    actor: String,
    opinion_kind: String,
    quote: String,
    body: String,
) -> Result<(), String> {
    let ws = open_workspace(&app, &source_id)?;
    backend_sync::add_opinion(ws.root(), &page_id, &id, &actor, &opinion_kind, &quote, &body)
}

#[tauri::command]
pub(crate) fn resolve_backend_sync_conflict(
    app: AppHandle,
    source_id: String,
    page_id: String,
    keep_local: bool,
) -> Result<BackendSyncReport, String> {
    let ws = open_workspace(&app, &source_id)?;
    backend_sync::resolve_conflict(&ws, &page_id, keep_local)
}
