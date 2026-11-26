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
        if super::temporary::is_temporary(&source_id) { return serde_json::to_value(super::temporary::list_reviews(&app, &source_id, &page_id)?).map_err(|error| error.to_string()); }
        let ws = open_workspace(&app, &source_id)?;
        serde_json::to_value(tie_storage::local::changes::list_reviews(ws.root(), &page_id)?).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn merge_page_reviews(app: AppHandle, source_id: String, page_id: String, entries: Vec<tie_storage::local::changes::ReviewEntry>) -> Result<tie_storage::local::changes::ReviewFile, String> {
    tauri::async_runtime::spawn_blocking(move || { let ws = open_workspace(&app, &source_id)?; tie_storage::local::changes::merge_review_file(ws.root(), &page_id, tie_storage::local::changes::ReviewFile { entries }) }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn add_page_opinion(
    app: AppHandle, source_id: String, page_id: String, id: String, actor: String,
    opinion_kind: String, quote: String, body: String, base_updated_at: Option<String>,
    reply_to: Option<String>, origin: Option<tie_storage::identity::ChangeOrigin>, at: Option<String>,
) -> Result<tie_storage::local::changes::ReviewFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let ws = open_workspace(&app, &source_id)?;
    tie_storage::local::changes::add_signal(ws.root(), &page_id, &id, &actor, &opinion_kind, &quote, &body,
        base_updated_at.as_deref().unwrap_or(""), reply_to.as_deref(), origin, at.as_deref())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn resolve_page_opinion(
    app: AppHandle, source_id: String, page_id: String, id: String, status: String,
    resolution_note: Option<String>, applied_updated_at: Option<String>, origin: Option<tie_storage::identity::ChangeOrigin>,
) -> Result<tie_storage::local::changes::ReviewFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let ws = open_workspace(&app, &source_id)?;
    tie_storage::local::changes::resolve_signal(ws.root(), &page_id, &id, &status,
        resolution_note.as_deref(), applied_updated_at.as_deref(), origin)
    }).await.map_err(|error| error.to_string())?
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
