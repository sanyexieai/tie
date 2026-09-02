use futures_util::StreamExt;
use minio::s3::{
    builders::ObjectContent,
    creds::StaticProvider,
    response::BucketExistsResponse,
    types::{BucketName, S3Api, ToStream},
    MinioClient, MinioClientBuilder,
};
use serde::{Deserialize, Serialize};
use tie_common::{Page, PageRevision, MAX_PAGE_REVISIONS};
use tie_local::{frontmatter, page_has_changed, parse_page, revision_id, sanitize_asset_name};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct S3Credentials {
    access_key: String,
    secret_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Connection {
    pub provider_id: String,
    pub endpoint: String,
    pub bucket: String,
    pub region: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3PageIndexEntry {
    pub page_id: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

fn is_minio_like_endpoint(endpoint: &str) -> bool {
    let lower = endpoint.to_ascii_lowercase();
    !lower.contains("amazonaws.com") && !lower.contains("cloudflarestorage.com")
}

pub fn s3_client(connection: &S3Connection, credential_payload: &str) -> Result<(MinioClient, BucketName), String> {
    let credentials: S3Credentials = serde_json::from_str(credential_payload)
        .map_err(|_| "本机 S3 密钥无效，请重新保存配置".to_owned())?;
    let endpoint = connection.endpoint.trim().parse()
        .map_err(|error| format!("Endpoint 格式无效：{error}"))?;
    let bucket = BucketName::new(connection.bucket.trim()).map_err(|error| format!("Bucket 名称无效：{error}"))?;
    let skip_region_lookup = is_minio_like_endpoint(connection.endpoint.trim())
        || connection.region.is_some();
    let client = MinioClientBuilder::new(endpoint)
        .skip_region_lookup(skip_region_lookup)
        .provider(Some(StaticProvider::new(&credentials.access_key, &credentials.secret_key, None)))
        .build()
        .map_err(|error| format!("无法创建 S3 客户端：{error}"))?;
    Ok((client, bucket))
}

fn s3_page_id_from_key(name: &str) -> Option<String> {
    name.strip_prefix("tie/pages/")?.strip_suffix(".md").map(str::to_owned)
}

async fn list_s3_object_index(
    connection: &S3Connection,
    credential_payload: &str,
) -> Result<Vec<S3PageIndexEntry>, String> {
    let (client, bucket) = s3_client(connection, credential_payload)?;
    let mut stream = client.list_objects(bucket.clone())
        .map_err(|error| format!("无法列出 S3 页面：{error}"))?
        .prefix(Some("tie/pages/".to_owned()))
        .recursive(true)
        .build()
        .to_stream()
        .await;
    let mut entries = Vec::new();
    while let Some(batch) = stream.next().await {
        let batch = batch.map_err(|error| format!("无法读取 S3 页面列表：{error}"))?;
        for entry in batch.contents.into_iter().filter(|entry| entry.name.ends_with(".md")) {
            let Some(page_id) = s3_page_id_from_key(&entry.name) else { continue };
            entries.push(S3PageIndexEntry {
                page_id,
                etag: entry.etag.clone(),
                last_modified: entry.last_modified.map(|value| value.to_rfc3339()),
            });
        }
    }
    Ok(entries)
}

async fn download_s3_page(
    client: &MinioClient,
    bucket: BucketName,
    source_id: &str,
    object_name: String,
) -> Result<Page, String> {
    let response = client.get_object(bucket, object_name)
        .map_err(|error| format!("无法读取 S3 页面：{error}"))?
        .build()
        .send()
        .await
        .map_err(|error| format!("无法下载 S3 页面：{error}"))?;
    let content = String::from_utf8(response.into_bytes().await.map_err(|error| format!("无法读取 S3 页面内容：{error}"))?.to_vec())
        .map_err(|_| "S3 页面不是 UTF-8 Markdown 文件".to_owned())?;
    let mut page = parse_page(&content).map_err(|error| format!("S3 页面格式无效：{error}"))?;
    page.storage_source_id = source_id.to_owned();
    Ok(page)
}

fn s3_page_object(page_id: &str) -> String {
    format!("tie/pages/{page_id}.md")
}

pub fn s3_history_prefix(page_id: &str) -> String {
    format!("tie/history/{page_id}/")
}

pub fn s3_history_object(page_id: &str, revision_id: &str) -> String {
    format!("tie/history/{page_id}/{revision_id}.md")
}

pub async fn list_s3_object_keys(
    client: &MinioClient,
    bucket: BucketName,
    prefix: &str,
) -> Result<Vec<String>, String> {
    let mut stream = client.list_objects(bucket)
        .map_err(|error| format!("无法列出 S3 对象：{error}"))?
        .prefix(Some(prefix.to_owned()))
        .recursive(true)
        .build()
        .to_stream()
        .await;
    let mut keys = Vec::new();
    while let Some(batch) = stream.next().await {
        let batch = batch.map_err(|error| format!("无法读取 S3 对象列表：{error}"))?;
        for entry in batch.contents {
            keys.push(entry.name);
        }
    }
    Ok(keys)
}

pub async fn trim_s3_history(client: &MinioClient, bucket: BucketName, page_id: &str) -> Result<(), String> {
    let prefix = s3_history_prefix(page_id);
    let mut keys = list_s3_object_keys(client, bucket.clone(), &prefix).await?;
    keys.sort();
    while keys.len() > MAX_PAGE_REVISIONS {
        let oldest = keys.remove(0);
        client.delete_object(bucket.clone(), oldest)
            .map_err(|error| format!("无法清理 S3 历史版本：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法清理 S3 历史版本：{error}"))?;
    }
    Ok(())
}

async fn archive_s3_page_revision(
    client: &MinioClient,
    bucket: BucketName,
    page: &Page,
) -> Result<(), String> {
    let revision_key = s3_history_object(&page.id, &revision_id());
    client.put_object_content(bucket.clone(), revision_key, ObjectContent::from(frontmatter(page)))
        .map_err(|error| format!("无法写入 S3 历史版本：{error}"))?
        .build()
        .send()
        .await
        .map_err(|error| format!("无法写入 S3 历史版本：{error}"))?;
    trim_s3_history(client, bucket, &page.id).await
}

async fn delete_s3_history(client: &MinioClient, bucket: BucketName, page_id: &str) -> Result<(), String> {
    for key in list_s3_object_keys(client, bucket.clone(), &s3_history_prefix(page_id)).await? {
        client.delete_object(bucket.clone(), key)
            .map_err(|error| format!("无法删除 S3 历史版本：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法删除 S3 历史版本：{error}"))?;
    }
    Ok(())
}

pub async fn list_s3_page_revisions(
    connection: &S3Connection,
    credential_payload: &str,
    page_id: &str,
) -> Result<Vec<PageRevision>, String> {
    let (client, bucket) = s3_client(connection, credential_payload)?;
    let mut revisions = Vec::new();
    for key in list_s3_object_keys(&client, bucket.clone(), &s3_history_prefix(page_id)).await? {
        if !key.ends_with(".md") {
            continue;
        }
        let response = client.get_object(bucket.clone(), key.clone())
            .map_err(|error| format!("无法读取 S3 历史版本：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法下载 S3 历史版本：{error}"))?;
        let content = String::from_utf8(response.into_bytes().await.map_err(|error| format!("无法读取 S3 历史版本内容：{error}"))?.to_vec())
            .map_err(|_| "S3 历史版本不是 UTF-8 Markdown 文件".to_owned())?;
        let page = parse_page(&content).map_err(|error| format!("S3 历史版本格式无效：{error}"))?;
        let id = key
            .trim_start_matches(&s3_history_prefix(page_id))
            .trim_end_matches(".md")
            .to_owned();
        revisions.push(PageRevision {
            id,
            saved_at: page.updated_at,
            title: page.title,
        });
    }
    revisions.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(revisions)
}

pub async fn read_s3_page_revision(
    connection: &S3Connection,
    credential_payload: &str,
    page: &Page,
    revision_id: &str,
) -> Result<Page, String> {
    let (client, bucket) = s3_client(connection, credential_payload)?;
    let key = s3_history_object(&page.id, revision_id);
    let mut revision = download_s3_page(&client, bucket, &page.storage_source_id, key).await?;
    revision.id = page.id.clone();
    revision.storage_source_id = page.storage_source_id.clone();
    revision.created_at = page.created_at.clone();
    Ok(revision)
}

pub async fn copy_s3_history_to_s3(
    source: &S3Connection,
    source_credential_payload: &str,
    target: &S3Connection,
    target_credential_payload: &str,
    page_id: &str,
) -> Result<(), String> {
    let (source_client, source_bucket) = s3_client(source, source_credential_payload)?;
    let (target_client, target_bucket) = s3_client(target, target_credential_payload)?;
    let keys = list_s3_object_keys(&source_client, source_bucket.clone(), &s3_history_prefix(page_id)).await?;
    for key in keys {
        if !key.ends_with(".md") {
            continue;
        }
        let response = source_client.get_object(source_bucket.clone(), key.clone())
            .map_err(|error| format!("无法读取 S3 历史版本：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法下载 S3 历史版本：{error}"))?;
        let content = response.into_bytes().await.map_err(|error| format!("无法读取 S3 历史版本内容：{error}"))?;
        target_client.put_object_content(target_bucket.clone(), key, ObjectContent::from(content.to_vec()))
            .map_err(|error| format!("无法复制 S3 历史版本：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法复制 S3 历史版本：{error}"))?;
    }
    trim_s3_history(&target_client, target_bucket, page_id).await
}

pub async fn copy_s3_assets_to_s3(
    source: &S3Connection,
    source_credential_payload: &str,
    target: &S3Connection,
    target_credential_payload: &str,
    page_id: &str,
) -> Result<(), String> {
    let (source_client, source_bucket) = s3_client(source, source_credential_payload)?;
    let (target_client, target_bucket) = s3_client(target, target_credential_payload)?;
    let keys = list_s3_object_keys(&source_client, source_bucket.clone(), &s3_asset_prefix(page_id)).await?;
    for key in keys {
        let response = source_client.get_object(source_bucket.clone(), key.clone())
            .map_err(|error| format!("无法读取 S3 附件：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法下载 S3 附件：{error}"))?;
        let data = response.into_bytes().await.map_err(|error| format!("无法读取 S3 附件内容：{error}"))?;
        target_client.put_object_content(target_bucket.clone(), key, ObjectContent::from(data.to_vec()))
            .map_err(|error| format!("无法复制 S3 附件：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法复制 S3 附件：{error}"))?;
    }
    Ok(())
}

pub async fn list_s3_page_assets(
    connection: &S3Connection,
    credential_payload: &str,
    page: &Page,
) -> Result<Vec<String>, String> {
    let (client, bucket) = s3_client(connection, credential_payload)?;
    let keys = list_s3_object_keys(&client, bucket, &s3_asset_prefix(&page.id)).await?;
    Ok(keys
        .into_iter()
        .filter_map(|key| key.strip_prefix(&s3_asset_prefix(&page.id)).map(str::to_owned))
        .collect())
}

pub async fn test_s3_connection(
    connection: &S3Connection,
    credential_payload: &str,
) -> Result<(), String> {
    let (client, bucket) = s3_client(connection, credential_payload)?;
    let response: BucketExistsResponse = client.bucket_exists(bucket)
        .map_err(|error| format!("无法检查 Bucket：{error}"))?
        .build()
        .send()
        .await
        .map_err(|error| format!("无法连接 S3：{error}"))?;
    if response.exists() { Ok(()) } else { Err("已连接 S3，但指定 Bucket 不存在或当前密钥无权访问".to_owned()) }
}

pub async fn list_s3_page_index(
    connection: &S3Connection,
    credential_payload: &str,
) -> Result<Vec<S3PageIndexEntry>, String> {
    list_s3_object_index(connection, credential_payload).await
}

pub async fn load_s3_pages(
    connection: &S3Connection,
    credential_payload: &str,
) -> Result<Vec<Page>, String> {
    let source_id = format!("s3:{}", connection.provider_id);
    let (client, bucket) = s3_client(connection, credential_payload)?;
    let index = list_s3_object_index(connection, credential_payload).await?;
    let mut pages = Vec::with_capacity(index.len());
    for entry in index {
        pages.push(download_s3_page(&client, bucket.clone(), &source_id, format!("tie/pages/{}.md", entry.page_id)).await?);
    }
    Ok(pages)
}

pub async fn load_s3_pages_by_ids(
    connection: &S3Connection,
    credential_payload: &str,
    page_ids: &[String],
) -> Result<Vec<Page>, String> {
    let source_id = format!("s3:{}", connection.provider_id);
    let (client, bucket) = s3_client(connection, credential_payload)?;
    let mut pages = Vec::with_capacity(page_ids.len());
    for page_id in page_ids {
        pages.push(download_s3_page(&client, bucket.clone(), &source_id, format!("tie/pages/{page_id}.md")).await?);
    }
    Ok(pages)
}

pub async fn save_s3_page(
    connection: &S3Connection,
    credential_payload: &str,
    page: &Page,
    expected_updated_at: Option<&str>,
) -> Result<Page, String> {
    let (client, bucket) = s3_client(connection, credential_payload)?;
    let object = s3_page_object(&page.id);
    if let Ok(previous) = download_s3_page(&client, bucket.clone(), &page.storage_source_id, object.clone()).await {
        if let Some(expected) = expected_updated_at {
            if previous.updated_at != expected {
                return Err("页面已在其他设备更新，请重新载入后再保存".to_owned());
            }
        }
        if page_has_changed(&previous, page) {
            archive_s3_page_revision(&client, bucket.clone(), &previous).await?;
        }
    }
    client.put_object_content(bucket, object, ObjectContent::from(frontmatter(page)))
        .map_err(|error| format!("无法创建 S3 写入请求：{error}"))?
        .build()
        .send()
        .await
        .map_err(|error| format!("无法保存 S3 页面：{error}"))?;
    Ok(page.clone())
}

pub async fn permanently_delete_s3_pages(
    connection: &S3Connection,
    credential_payload: &str,
    page_ids: &[String],
) -> Result<(), String> {
    let (client, bucket) = s3_client(connection, credential_payload)?;
    for page_id in page_ids {
        delete_s3_history(&client, bucket.clone(), page_id).await?;
        client.delete_object(bucket.clone(), s3_page_object(page_id))
            .map_err(|error| format!("无法创建 S3 删除请求：{error}"))?
            .build()
            .send()
            .await
            .map_err(|error| format!("无法彻底删除 S3 页面：{error}"))?;
    }
    Ok(())
}

pub fn s3_asset_prefix(page_id: &str) -> String {
    format!("tie/assets/{page_id}/")
}

pub fn s3_asset_object(page_id: &str, asset_name: &str) -> String {
    format!("tie/assets/{page_id}/{asset_name}")
}

pub async fn save_s3_page_asset(
    connection: &S3Connection,
    credential_payload: &str,
    page: &Page,
    file_name: &str,
    data: &[u8],
) -> Result<String, String> {
    if data.is_empty() {
        return Err("附件内容为空".to_owned());
    }
    if data.len() > 20 * 1024 * 1024 {
        return Err("附件超过 20 MB".to_owned());
    }
    let asset_name = sanitize_asset_name(file_name)?;
    let (client, bucket) = s3_client(connection, credential_payload)?;
    client
        .put_object_content(bucket, s3_asset_object(&page.id, &asset_name), ObjectContent::from(data.to_vec()))
        .map_err(|error| format!("无法创建 S3 附件写入请求：{error}"))?
        .build()
        .send()
        .await
        .map_err(|error| format!("无法保存 S3 附件：{error}"))?;
    Ok(asset_name)
}

pub async fn read_s3_page_asset(
    connection: &S3Connection,
    credential_payload: &str,
    page: &Page,
    asset_name: &str,
) -> Result<Vec<u8>, String> {
    let asset_name = sanitize_asset_name(asset_name)?;
    let (client, bucket) = s3_client(connection, credential_payload)?;
    let response = client
        .get_object(bucket, s3_asset_object(&page.id, &asset_name))
        .map_err(|error| format!("无法读取 S3 附件：{error}"))?
        .build()
        .send()
        .await
        .map_err(|error| format!("无法下载 S3 附件：{error}"))?;
    Ok(response
        .into_bytes()
        .await
        .map_err(|error| format!("无法读取 S3 附件内容：{error}"))?
        .to_vec())
}
