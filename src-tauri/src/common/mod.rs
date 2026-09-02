pub(crate) mod settings;

pub(crate) use settings::{app_data_dir, load_settings, save_settings, workspace_sources};
pub(crate) use tie_storage::{
    Page, PageRevision, S3ProviderConfig, StorageSource, WorkspaceSnapshot,
};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) use tie_storage::{WorkspaceSettings};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) use tie_storage::local::{
    copy_page_assets, copy_page_history, frontmatter, markdown_path, normalize_page_sources,
    page_asset_dir, parse_page, remove_page_assets, revision_dir, sanitize_asset_name,
    source_from_path,
};
