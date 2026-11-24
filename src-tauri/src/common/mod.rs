pub(crate) mod settings;

pub(crate) use settings::{app_data_dir, load_settings, save_settings, workspace_sources};
pub(crate) use tie_storage::{
    Page, PageRevision, S3ProviderConfig, StorageSource, WorkspaceSnapshot,
};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) use tie_storage::WorkspaceSettings;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) use tie_storage::local::{
    copy_page_assets, copy_page_history, find_page_file, is_tie_document,
    normalize_page_sources, open_or_adopt, page_asset_dir, parse_page, remove_page_assets,
    revision_dir, sanitize_asset_name, save_page_to_root, source_from_path,
};
