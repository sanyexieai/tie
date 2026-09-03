use crate::common::{app_data_dir, load_settings, save_settings, workspace_sources};
use tauri::AppHandle;
use tie_storage::local::{
    io, load_file_workspace, register_storage_source, resolve_directory_path, Page, PageRevision,
    WorkspaceSettings, WorkspaceSnapshot,
};

#[tauri::command]
pub(crate) fn load_workspace(app: AppHandle) -> Result<WorkspaceSnapshot, String> {
    load_file_workspace(&app_data_dir(&app)?, "tie-workspace")
}

#[tauri::command]
pub(crate) fn add_storage_source(
    app: AppHandle,
    path: String,
    kind: Option<String>,
) -> Result<WorkspaceSnapshot, String> {
    let root = resolve_directory_path(&path)?;
    let kind = kind.unwrap_or_else(|| "local".to_owned());
    register_storage_source(&app_data_dir(&app)?, root, kind)?;
    load_file_workspace(&app_data_dir(&app)?, "tie-workspace")
}

#[tauri::command]
pub(crate) fn save_page(
    app: AppHandle,
    page: Page,
    expected_updated_at: Option<String>,
    write_source_id: Option<String>,
) -> Result<Page, String> {
    let (sources, _) = workspace_sources(&app)?;
    io::save_page(
        &sources,
        page,
        expected_updated_at.as_deref(),
        write_source_id.as_deref(),
    )
}

#[tauri::command]
pub(crate) fn list_file_page_assets(app: AppHandle, page: Page) -> Result<Vec<String>, String> {
    let (sources, _) = workspace_sources(&app)?;
    io::list_file_page_assets(&page, &sources)
}

#[tauri::command]
pub(crate) fn list_page_revisions(
    app: AppHandle,
    page_id: String,
    storage_source_id: String,
) -> Result<Vec<PageRevision>, String> {
    let (sources, _) = workspace_sources(&app)?;
    io::list_page_revisions(&sources, &page_id, &storage_source_id)
}

#[tauri::command]
pub(crate) fn read_page_revision(
    app: AppHandle,
    page: Page,
    revision_id: String,
) -> Result<Page, String> {
    let (sources, _) = workspace_sources(&app)?;
    io::read_page_revision(&sources, &page, &revision_id)
}

#[tauri::command]
pub(crate) fn restore_page_revision(
    app: AppHandle,
    page: Page,
    revision_id: String,
) -> Result<Page, String> {
    let (sources, _) = workspace_sources(&app)?;
    io::restore_page_revision(&sources, page, &revision_id)
}

#[tauri::command]
pub(crate) fn export_page_markdown(page: Page, target_path: String) -> Result<(), String> {
    io::export_page_markdown(&page, &target_path)
}

#[tauri::command]
pub(crate) fn permanently_delete_pages(app: AppHandle, pages: Vec<Page>) -> Result<(), String> {
    let (sources, _) = workspace_sources(&app)?;
    io::permanently_delete_pages(&sources, &pages)
}

#[tauri::command]
pub(crate) fn remove_storage_source(
    app: AppHandle,
    source_id: String,
) -> Result<WorkspaceSnapshot, String> {
    let existing_settings = load_settings(&app)?;
    let (mut sources, _) = workspace_sources(&app)?;
    if sources.len() <= 1 {
        return Err("至少需要保留一个存储源".to_owned());
    }
    if !sources.iter().any(|source| source.id == source_id) {
        return Err("存储源不存在".to_owned());
    }
    for source in &sources {
        if source.id != source_id {
            continue;
        }
        let pages_dir = std::path::PathBuf::from(&source.path).join("pages");
        let entries = std::fs::read_dir(pages_dir)
            .map_err(|error| format!("无法确认该存储源是否为空，请恢复访问后重试：{error}"))?;
        if entries.filter_map(Result::ok).any(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "md")
        }) {
            return Err("该存储源仍包含页面，请先迁移页面后再断开".to_owned());
        }
    }
    sources.retain(|source| source.id != source_id);
    save_settings(
        &app,
        &WorkspaceSettings {
            name: existing_settings.name,
            path: String::new(),
            kind: String::new(),
            sources,
            s3_providers: existing_settings.s3_providers,
        },
    )?;
    load_file_workspace(&app_data_dir(&app)?, "tie-workspace")
}

#[tauri::command]
pub(crate) fn rename_storage_source(
    app: AppHandle,
    source_id: String,
    name: String,
) -> Result<WorkspaceSnapshot, String> {
    let clean_name = name.trim();
    if clean_name.is_empty() || clean_name.chars().count() > 80 {
        return Err("存储源名称需为 1 至 80 个字符".to_owned());
    }
    let existing_settings = load_settings(&app)?;
    let (mut sources, _) = workspace_sources(&app)?;
    let source = sources
        .iter_mut()
        .find(|source| source.id == source_id)
        .ok_or("存储源不存在")?;
    source.name = clean_name.to_owned();
    save_settings(
        &app,
        &WorkspaceSettings {
            name: existing_settings.name,
            path: String::new(),
            kind: String::new(),
            sources,
            s3_providers: existing_settings.s3_providers,
        },
    )?;
    load_file_workspace(&app_data_dir(&app)?, "tie-workspace")
}

#[tauri::command]
pub(crate) fn rename_workspace(app: AppHandle, name: String) -> Result<WorkspaceSnapshot, String> {
    let clean_name = name.trim();
    if clean_name.is_empty() || clean_name.chars().count() > 80 {
        return Err("工作区名称需为 1 至 80 个字符".to_owned());
    }
    let mut settings = load_settings(&app)?;
    settings.name = clean_name.to_owned();
    save_settings(&app, &settings)?;
    load_file_workspace(&app_data_dir(&app)?, "tie-workspace")
}

#[tauri::command]
pub(crate) fn save_file_page_asset(
    app: AppHandle,
    page: Page,
    file_name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    let (sources, _) = workspace_sources(&app)?;
    io::save_file_page_asset(&sources, &page, &file_name, &data)
}

#[tauri::command]
pub(crate) fn read_file_page_asset(
    app: AppHandle,
    page: Page,
    asset_name: String,
) -> Result<Vec<u8>, String> {
    let (sources, _) = workspace_sources(&app)?;
    io::read_file_page_asset(&sources, &page, &asset_name)
}
