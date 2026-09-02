use crate::common::{load_settings, save_settings, Page, PageRevision, S3ProviderConfig};
#[cfg(any(target_os = "android", target_os = "ios"))]
use crate::mobile;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tie_storage::s3::{S3Connection, S3PageIndexEntry};

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::credentials;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct S3Credentials {
    access_key: String,
    secret_key: String,
}

fn normalize_s3_endpoint(endpoint: &str) -> String {
    endpoint.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn normalize_s3_bucket(bucket: &str) -> String {
    bucket.trim().to_ascii_lowercase()
}

/// FNV-1a 64-bit，与前端 `fnv1a64Hex` / `s3ProviderIdFromEndpointBucket` 一致。
fn s3_provider_fingerprint(endpoint: &str, bucket: &str) -> String {
    let material = format!(
        "{}\0{}",
        normalize_s3_endpoint(endpoint),
        normalize_s3_bucket(bucket)
    );
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in material.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn write_s3_credential_payload(app: &tauri::AppHandle, provider_id: &str, payload: &str) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return mobile::write_mobile_credential(app, provider_id, payload);
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        credentials::write_keyring_credential(provider_id, payload)
    }
}

fn delete_s3_credential_payload(app: &tauri::AppHandle, provider_id: &str) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return mobile::delete_mobile_credential(app, provider_id);
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        credentials::remove_keyring_credential(provider_id)
    }
}

fn migrate_s3_credential_id(app: &tauri::AppHandle, from_id: &str, to_id: &str) {
    if from_id == to_id || from_id.is_empty() || to_id.is_empty() {
        return;
    }
    if let Ok(payload) = read_s3_credential_payload(app, from_id) {
        let _ = write_s3_credential_payload(app, to_id, &payload);
        let _ = delete_s3_credential_payload(app, from_id);
    }
}

/// 将随机 UUID provider id 规范为 endpoint+bucket 指纹，并迁移凭据。
fn stabilize_s3_providers(app: &tauri::AppHandle, providers: Vec<S3ProviderConfig>) -> (Vec<S3ProviderConfig>, bool) {
    let mut changed = false;
    let mut by_stable: HashMap<String, S3ProviderConfig> = HashMap::new();

    for mut provider in providers {
        let stable_id = s3_provider_fingerprint(&provider.endpoint, &provider.bucket);
        if provider.id != stable_id {
            migrate_s3_credential_id(app, &provider.id, &stable_id);
            provider.id = stable_id.clone();
            changed = true;
        }
        match by_stable.get(&stable_id) {
            None => {
                by_stable.insert(stable_id, provider);
            }
            Some(existing) => {
                changed = true;
                let merged = S3ProviderConfig {
                    id: stable_id.clone(),
                    name: if existing.name.is_empty() {
                        provider.name.clone()
                    } else {
                        existing.name.clone()
                    },
                    endpoint: provider.endpoint.clone(),
                    bucket: provider.bucket.clone(),
                    region: provider.region.clone().or_else(|| existing.region.clone()),
                    credential_stored: existing.credential_stored || provider.credential_stored,
                    created_at: if existing.created_at <= provider.created_at {
                        existing.created_at.clone()
                    } else {
                        provider.created_at.clone()
                    },
                };
                by_stable.insert(stable_id, merged);
            }
        }
    }

    let next: Vec<S3ProviderConfig> = by_stable.into_values().collect();
    (next, changed)
}

pub(crate) fn read_s3_credential_payload(app: &tauri::AppHandle, provider_id: &str) -> Result<String, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return mobile::read_mobile_credential(app, provider_id);
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        credentials::read_keyring_credential(provider_id)
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn s3_client_for_app(
    app: &tauri::AppHandle,
    connection: &S3Connection,
) -> Result<(minio::s3::MinioClient, minio::s3::types::BucketName), String> {
    let payload = read_s3_credential_payload(app, &connection.provider_id)?;
    tie_storage::s3::s3_client(connection, &payload)
}

#[tauri::command]
pub(crate) fn load_s3_providers(app: tauri::AppHandle) -> Result<Vec<S3ProviderConfig>, String> {
    let mut settings = load_settings(&app)?;
    let (providers, changed) = stabilize_s3_providers(&app, settings.s3_providers.clone());
    if changed {
        settings.s3_providers = providers.clone();
        save_settings(&app, &settings)?;
    }
    Ok(providers)
}

#[tauri::command]
pub(crate) fn save_s3_providers(app: tauri::AppHandle, providers: Vec<S3ProviderConfig>) -> Result<(), String> {
    let mut settings = load_settings(&app)?;
    settings.s3_providers = providers;
    save_settings(&app, &settings)
}

#[tauri::command]
pub(crate) fn upsert_s3_provider(app: tauri::AppHandle, provider: S3ProviderConfig) -> Result<Vec<S3ProviderConfig>, String> {
    let mut settings = load_settings(&app)?;
    let mut next = provider;
    let stable_id = s3_provider_fingerprint(&next.endpoint, &next.bucket);
    if next.id != stable_id {
        migrate_s3_credential_id(&app, &next.id, &stable_id);
        next.id = stable_id;
    }
    if let Some(existing) = settings.s3_providers.iter_mut().find(|item| item.id == next.id) {
        *existing = next;
    } else {
        settings.s3_providers.push(next);
    }
    let (providers, _) = stabilize_s3_providers(&app, settings.s3_providers.clone());
    settings.s3_providers = providers.clone();
    save_settings(&app, &settings)?;
    Ok(providers)
}

#[tauri::command]
pub(crate) fn remove_s3_provider_config(app: tauri::AppHandle, provider_id: String) -> Result<Vec<S3ProviderConfig>, String> {
    let mut settings = load_settings(&app)?;
    settings.s3_providers.retain(|provider| provider.id != provider_id);
    save_settings(&app, &settings)?;
    Ok(settings.s3_providers)
}

#[tauri::command]
pub(crate) async fn list_s3_page_revisions(
    app: tauri::AppHandle,
    connection: S3Connection,
    page_id: String,
) -> Result<Vec<PageRevision>, String> {
    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    tie_storage::s3::list_s3_page_revisions(&connection, &payload, &page_id).await
}

#[tauri::command]
pub(crate) async fn read_s3_page_revision(
    app: tauri::AppHandle,
    connection: S3Connection,
    page: Page,
    revision_id: String,
) -> Result<Page, String> {
    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    tie_storage::s3::read_s3_page_revision(&connection, &payload, &page, &revision_id).await
}

#[tauri::command]
pub(crate) async fn copy_s3_history_to_s3(
    app: tauri::AppHandle,
    source: S3Connection,
    target: S3Connection,
    page_id: String,
) -> Result<(), String> {
    let source_payload = read_s3_credential_payload(&app, &source.provider_id)?;
    let target_payload = read_s3_credential_payload(&app, &target.provider_id)?;
    tie_storage::s3::copy_s3_history_to_s3(&source, &source_payload, &target, &target_payload, &page_id).await
}

#[tauri::command]
pub(crate) async fn copy_s3_assets_to_s3(
    app: tauri::AppHandle,
    source: S3Connection,
    target: S3Connection,
    page_id: String,
) -> Result<(), String> {
    let source_payload = read_s3_credential_payload(&app, &source.provider_id)?;
    let target_payload = read_s3_credential_payload(&app, &target.provider_id)?;
    tie_storage::s3::copy_s3_assets_to_s3(&source, &source_payload, &target, &target_payload, &page_id).await
}

#[tauri::command]
pub(crate) async fn list_s3_page_assets(
    app: tauri::AppHandle,
    connection: S3Connection,
    page: Page,
) -> Result<Vec<String>, String> {
    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    tie_storage::s3::list_s3_page_assets(&connection, &payload, &page).await
}

#[tauri::command]
pub(crate) fn save_s3_credentials(
    app: tauri::AppHandle,
    provider_id: String,
    access_key: String,
    secret_key: String,
) -> Result<(), String> {
    if access_key.trim().is_empty() || secret_key.is_empty() {
        return Err("Access Key 和 Secret Key 不能为空".to_owned());
    }
    let payload = serde_json::to_string(&S3Credentials {
        access_key: access_key.trim().to_owned(),
        secret_key,
    })
    .map_err(|error| error.to_string())?;
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return mobile::write_mobile_credential(&app, &provider_id, &payload);
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        credentials::write_keyring_credential(&provider_id, &payload)
    }
}

#[tauri::command]
pub(crate) fn remove_s3_credentials(app: tauri::AppHandle, provider_id: String) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return mobile::delete_mobile_credential(&app, &provider_id);
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        credentials::remove_keyring_credential(&provider_id)
    }
}

#[tauri::command]
pub(crate) async fn test_s3_connection(
    app: tauri::AppHandle,
    provider_id: String,
    endpoint: String,
    bucket: String,
    region: Option<String>,
) -> Result<(), String> {
    let connection = S3Connection { provider_id, endpoint, bucket, region };
    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    tie_storage::s3::test_s3_connection(&connection, &payload).await
}

#[tauri::command]
pub(crate) async fn list_s3_page_index(app: tauri::AppHandle, connection: S3Connection) -> Result<Vec<S3PageIndexEntry>, String> {
    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    tie_storage::s3::list_s3_page_index(&connection, &payload).await
}

#[tauri::command]
pub(crate) async fn load_s3_pages(app: tauri::AppHandle, connection: S3Connection) -> Result<Vec<Page>, String> {
    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    tie_storage::s3::load_s3_pages(&connection, &payload).await
}

#[tauri::command]
pub(crate) async fn load_s3_pages_by_ids(
    app: tauri::AppHandle,
    connection: S3Connection,
    page_ids: Vec<String>,
) -> Result<Vec<Page>, String> {
    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    tie_storage::s3::load_s3_pages_by_ids(&connection, &payload, &page_ids).await
}

#[tauri::command]
pub(crate) async fn save_s3_page(
    app: tauri::AppHandle,
    connection: S3Connection,
    page: Page,
    expected_updated_at: Option<String>,
) -> Result<Page, String> {
    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    tie_storage::s3::save_s3_page(
        &connection,
        &payload,
        &page,
        expected_updated_at.as_deref(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn permanently_delete_s3_pages(
    app: tauri::AppHandle,
    connection: S3Connection,
    page_ids: Vec<String>,
) -> Result<(), String> {
    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    tie_storage::s3::permanently_delete_s3_pages(&connection, &payload, &page_ids).await
}

#[tauri::command]
pub(crate) async fn save_s3_page_asset(
    app: tauri::AppHandle,
    connection: S3Connection,
    page: Page,
    file_name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    tie_storage::s3::save_s3_page_asset(&connection, &payload, &page, &file_name, &data).await
}

#[tauri::command]
pub(crate) async fn read_s3_page_asset(
    app: tauri::AppHandle,
    connection: S3Connection,
    page: Page,
    asset_name: String,
) -> Result<Vec<u8>, String> {
    let payload = read_s3_credential_payload(&app, &connection.provider_id)?;
    tie_storage::s3::read_s3_page_asset(&connection, &payload, &page, &asset_name).await
}
