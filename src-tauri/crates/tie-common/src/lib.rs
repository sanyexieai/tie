use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageKind {
    Local,
    Smb,
    S3,
    Backend,
}

impl StorageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Smb => "smb",
            Self::S3 => "s3",
            Self::Backend => "backend",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "local" => Some(Self::Local),
            "smb" => Some(Self::Smb),
            "s3" => Some(Self::S3),
            "backend" => Some(Self::Backend),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub sources: Vec<StorageSource>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSource {
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
pub struct Page {
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub workspace: Workspace,
    pub pages: Vec<Page>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRevision {
    pub id: String,
    pub saved_at: String,
    pub title: String,
}

pub const MAX_PAGE_REVISIONS: usize = 80;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSettings {
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

pub fn default_created_at() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_owned())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3ProviderConfig {
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
