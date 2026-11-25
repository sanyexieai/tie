use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tie_cli::backend_sync::{self, BackendSyncReport};

use super::source_root;

fn open_workspace(app: &AppHandle, source_id: &str) -> Result<tie_storage::local::LocalWorkspace, String> {
    let root = source_root(app, source_id)?;
    tie_storage::local::LocalWorkspace::open(&root, Some(source_id))
}

#[tauri::command]
pub(crate) async fn backend_sync_cursor(app: AppHandle, source_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ws = open_workspace(&app, &source_id)?;
        backend_sync::read_sync_cursor(ws.root())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn sync_backend_workspace(
    app: AppHandle,
    source_id: String,
    url: String,
    workspace_id: String,
) -> Result<BackendSyncReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ws = open_workspace(&app, &source_id)?;
        let mut last_emit = None;
        backend_sync::align_with_progress(&ws, &url, &workspace_id, |progress| {
            let emit = progress.completed == 0 || progress.completed == progress.total
                || last_emit.is_none_or(|(stage, time): (_, Instant)| {
                    stage != progress.stage || time.elapsed() >= Duration::from_millis(100)
                });
            if emit {
                let _ = app.emit("backend-sync-progress", serde_json::json!({
                    "sourceId": source_id,
                    "stage": progress.stage,
                    "completed": progress.completed,
                    "total": progress.total,
                }));
                last_emit = Some((progress.stage, Instant::now()));
            }
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn list_page_reviews(app: AppHandle, source_id: String, page_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ws = open_workspace(&app, &source_id)?;
        Ok(backend_sync::read_review_file(ws.root(), &page_id))
    })
    .await
    .map_err(|error| error.to_string())?
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
pub(crate) async fn resolve_backend_sync_conflict(
    app: AppHandle,
    source_id: String,
    page_id: String,
    keep_local: bool,
) -> Result<BackendSyncReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ws = open_workspace(&app, &source_id)?;
        backend_sync::resolve_conflict(&ws, &page_id, keep_local)
    })
    .await
    .map_err(|error| error.to_string())?
}
