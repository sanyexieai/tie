use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Workspace {
    pub id: String,
    pub name: String,
    pub sources: Vec<StorageSource>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageSource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: String,
    #[serde(default = "default_source_available")]
    pub available: bool,
}

fn default_source_available() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub icon: String,
    pub parent_id: Option<String>,
    pub sort_key: i64,
    pub markdown: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub storage_source_id: String,
    #[serde(default)]
    pub storage_source_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSnapshot {
    pub workspace: Workspace,
    pub pages: Vec<Page>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageRevision {
    pub id: String,
    pub saved_at: String,
    pub title: String,
}

pub(crate) const MAX_PAGE_REVISIONS: usize = 80;

#[derive(Deserialize, Serialize)]
pub(crate) struct WorkspaceSettings {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub sources: Vec<StorageSource>,
    #[serde(default, rename = "s3Providers")]
    pub s3_providers: Vec<S3ProviderConfig>,
}

pub(crate) fn default_created_at() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_owned())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct S3ProviderConfig {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub bucket: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default)]
    pub credential_stored: bool,
    #[serde(default = "default_created_at")]
    pub created_at: String,
}
