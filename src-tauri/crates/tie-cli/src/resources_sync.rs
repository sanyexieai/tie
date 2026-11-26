use reqwest::blocking::{Client, Response};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use tie_local::{merge_file_metadata, page_asset_dir, LocalWorkspace};
use crate::backend_sync::{report_progress, BackendSyncProgress, BackendSyncStage};

pub(crate) fn sync_resources(
    client: &Client,
    base: &str,
    token: &str,
    ws: &LocalWorkspace,
    observe: &mut dyn FnMut(BackendSyncProgress),
) -> Result<(), String> {
    let pages = ws.load_all(true)?;
    report_progress(observe, BackendSyncStage::Assets, 0, pages.len());
    for (index, page) in pages.iter().enumerate() {
        sync_assets(client, base, token, ws.root(), &page.id)?;
        report_progress(observe, BackendSyncStage::Assets, index + 1, pages.len());
    }
    sync_files(client, base, token, ws, observe)
}

fn checked(response: Result<Response, reqwest::Error>) -> Result<Response, String> {
    let response = response.map_err(|error| format!("附件同步失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("附件同步失败：{}", response.status()));
    }
    Ok(response)
}

fn safe_component(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
    {
        return Err("附件或文件资源路径无效".into());
    }
    Ok(value)
}

fn sync_assets(
    client: &Client,
    base: &str,
    token: &str,
    root: &Path,
    page_id: &str,
) -> Result<(), String> {
    let page_id = safe_component(page_id)?;
    let url = format!("{base}/pages/{page_id}/assets");
    let listing: Value = checked(client.get(&url).bearer_auth(token).send())?
        .json()
        .map_err(|error| error.to_string())?;
    let remote = listing
        .get("assets")
        .and_then(Value::as_array)
        .ok_or("后台附件列表无效")?;
    let mut missing = std::collections::HashSet::new();
    for name in remote {
        missing.insert(safe_component(name.as_str().ok_or("后台附件名称无效")?)?.to_owned());
    }
    let dir = page_asset_dir(root, page_id);
    if dir.is_dir() {
        for item in fs::read_dir(&dir).map_err(|error| error.to_string())? {
            let item = item.map_err(|error| error.to_string())?;
            if !item
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                continue;
            }
            let name = item.file_name().to_string_lossy().into_owned();
            safe_component(&name)?;
            if !missing.remove(&name) {
                checked(
                    client
                        .put(format!("{url}/{name}"))
                        .bearer_auth(token)
                        .header("content-type", "application/octet-stream")
                        .body(fs::read(item.path()).map_err(|error| error.to_string())?)
                        .send(),
                )?;
            }
        }
    }
    for name in missing {
        let bytes = checked(
            client
                .get(format!("{url}/{name}"))
                .bearer_auth(token)
                .send(),
        )?
        .bytes()
        .map_err(|error| error.to_string())?;
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        fs::write(dir.join(name), bytes).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn field<'a>(meta: &'a Value, name: &str) -> &'a str {
    meta.get(name).and_then(Value::as_str).unwrap_or("")
}

fn copy_path(root: &Path, meta: &Value) -> Result<PathBuf, String> {
    let id = field(meta, "id");
    let stored = field(meta, "storedPath").replace('\\', "/");
    let name = stored.rsplit('/').next().ok_or("文件副本路径无效")?;
    Ok(root
        .join(".tie")
        .join("files")
        .join(id)
        .join(safe_component(name)?))
}

fn check_file(meta: &Value) -> Result<&str, String> {
    let id = safe_component(field(meta, "id"))?;
    if !id.starts_with("file_") || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
        return Err("文件资源 id 无效".into());
    }
    if field(meta, "mode") == "copy" && field(meta, "kind") == "directory" {
        return Err("目录副本尚未同步：后台暂不支持复制目录，本地目录已保留".into());
    }
    Ok(id)
}

fn upload_file(
    client: &Client,
    base: &str,
    token: &str,
    root: &Path,
    meta: &Value,
) -> Result<(), String> {
    let clean = merge_file_metadata(&Value::Null, meta);
    let meta = &clean;
    let id = field(meta, "id");
    let url = format!("{base}/files/{id}");
    if field(meta, "mode") == "copy" {
        let path = copy_path(root, meta)?;
        let bytes = fs::read(&path).map_err(|error| format!("文件副本尚未同步：{error}"))?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("文件副本名称无效")?;
        checked(
            client
                .put(format!("{url}/blob/{name}"))
                .bearer_auth(token)
                .header("content-type", "application/octet-stream")
                .body(bytes)
                .send(),
        )?;
    }
    checked(client.put(url).bearer_auth(token).json(meta).send())?;
    Ok(())
}

fn download_file(
    client: &Client,
    base: &str,
    token: &str,
    ws: &LocalWorkspace,
    meta: &Value,
) -> Result<(), String> {
    let id = field(meta, "id");
    let mut meta = meta.clone();
    if field(&meta, "mode") == "copy" {
        let path = copy_path(ws.root(), &meta)?;
        let bytes = checked(
            client
                .get(format!("{base}/files/{id}/blob"))
                .bearer_auth(token)
                .send(),
        )?
        .bytes()
        .map_err(|error| error.to_string())?;
        fs::create_dir_all(path.parent().ok_or("文件副本目录无效")?)
            .map_err(|error| error.to_string())?;
        fs::write(&path, bytes).map_err(|error| error.to_string())?;
        meta["storedPath"] = Value::String(format!(
            ".tie/files/{id}/{}",
            path.file_name().unwrap().to_string_lossy()
        ));
    }
    ws.files().upsert_metadata(&meta)
}

fn sync_files(
    client: &Client,
    base: &str,
    token: &str,
    ws: &LocalWorkspace,
    observe: &mut dyn FnMut(BackendSyncProgress),
) -> Result<(), String> {
    let response: Value = checked(
        client
            .get(format!("{base}/files"))
            .bearer_auth(token)
            .send(),
    )?
    .json()
    .map_err(|error| error.to_string())?;
    let files = response
        .get("files")
        .and_then(Value::as_array)
        .ok_or("后台文件列表无效")?;
    let mut remote = HashMap::new();
    for meta in files {
        remote.insert(check_file(meta)?.to_owned(), meta);
    }
    let local_files = ws.files().all_metadata();
    let total = local_files.iter().map(|meta| field(meta, "id"))
        .chain(remote.keys().map(String::as_str)).collect::<HashSet<_>>().len();
    let mut completed = HashSet::new();
    report_progress(observe, BackendSyncStage::Files, 0, total);
    for local in local_files {
        let id = check_file(&local)?;
        if let Some(other) = remote.remove(id) {
            if field(&local, "mode") == "link" && field(other, "mode") == "link" {
                let merged = merge_file_metadata(&local, other);
                if merged != merge_file_metadata(&Value::Null, &local) { ws.files().upsert_metadata(&merged)?; }
                if merged != merge_file_metadata(&Value::Null, other) || other.get("preview").is_some() {
                    upload_file(client, base, token, ws.root(), &merged)?;
                }
                if completed.insert(id.to_owned()) {
                    report_progress(observe, BackendSyncStage::Files, completed.len(), total);
                }
                continue;
            }
            let local_stamp = field(&local, "updatedAt");
            let remote_stamp = field(other, "updatedAt");
            if local_stamp > remote_stamp {
                upload_file(client, base, token, ws.root(), &local)?;
            } else if local_stamp < remote_stamp {
                download_file(client, base, token, ws, other)?;
            } else if field(&local, "mode") == "copy" {
                if copy_path(ws.root(), &local)?.is_file() {
                    if other.get("exists").and_then(Value::as_bool) == Some(false) {
                        upload_file(client, base, token, ws.root(), &local)?;
                    }
                } else {
                    download_file(client, base, token, ws, other)?;
                }
            }
        } else {
            upload_file(client, base, token, ws.root(), &local)?;
        }
        if completed.insert(id.to_owned()) {
            report_progress(observe, BackendSyncStage::Files, completed.len(), total);
        }
    }
    for other in remote.into_values() {
        download_file(client, base, token, ws, other)?;
        if completed.insert(field(other, "id").to_owned()) {
            report_progress(observe, BackendSyncStage::Files, completed.len(), total);
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use tie_local::{FileRegistry, WritePageInput};

    pub(crate) fn respond(root: &Path, request: &str, body: &[u8]) -> (u16, Vec<u8>) {
        let parts: Vec<_> = request.split_whitespace().collect();
        let method = parts[0];
        let path: Vec<_> = parts[1].trim_start_matches('/').split('/').collect();
        let registry = FileRegistry::new(root, Some("src_test"));
        let value = match path.as_slice() {
            ["pages", id, "assets"] => {
                let dir = page_asset_dir(root, id);
                let names: Vec<_> = fs::read_dir(dir)
                    .ok()
                    .into_iter()
                    .flatten()
                    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                    .collect();
                json!({ "assets": names })
            }
            ["pages", id, "assets", name] => {
                let file = page_asset_dir(root, id).join(name);
                if method == "GET" {
                    return (200, fs::read(file).unwrap());
                }
                fs::create_dir_all(file.parent().unwrap()).unwrap();
                fs::write(file, body).unwrap();
                json!({ "assetName": name })
            }
            ["files"] => {
                let files: Vec<_> = registry
                    .all_metadata()
                    .into_iter()
                    .map(|mut meta| {
                        meta["exists"] = json!(
                            field(&meta, "mode") == "copy"
                                && copy_path(root, &meta).unwrap().is_file()
                        );
                        meta
                    })
                    .collect();
                json!({ "files": files })
            }
            ["files", _id] if method == "PUT" => {
                let meta: Value = serde_json::from_slice(body).unwrap();
                registry.upsert_metadata(&meta).unwrap();
                meta
            }
            ["files", id, "blob", name] if method == "PUT" => {
                let dir = root.join(".tie/files").join(id);
                fs::create_dir_all(&dir).unwrap();
                fs::write(dir.join(name), body).unwrap();
                json!({ "blobName": name })
            }
            ["files", id, "blob"] => {
                let meta = registry.get(id).unwrap().unwrap();
                return (200, fs::read(copy_path(root, &meta).unwrap()).unwrap());
            }
            _ => return (404, b"{}".to_vec()),
        };
        (200, serde_json::to_vec(&value).unwrap())
    }

    #[test]
    fn resources_roundtrip_and_copy_replacement() {
        let dir = std::env::temp_dir().join(format!("tie-resource-sync-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let local = LocalWorkspace::init(&dir.join("local"), "src_test").unwrap();
        let remote = LocalWorkspace::init(&dir.join("remote"), "src_test").unwrap();
        let page = local
            .write_page(WritePageInput {
                title: Some("assets".into()),
                ..Default::default()
            })
            .unwrap()
            .page;
        let local_assets = page_asset_dir(local.root(), &page.id);
        let remote_assets = page_asset_dir(remote.root(), &page.id);
        fs::create_dir_all(&local_assets).unwrap();
        fs::create_dir_all(&remote_assets).unwrap();
        fs::write(local_assets.join("upload.png"), b"upload").unwrap();
        fs::write(remote_assets.join("download.png"), b"download").unwrap();
        let sample = dir.join("sample.txt");
        fs::write(&sample, b"local copy").unwrap();
        let mut local_file = local.files().ingest("copy", &sample, None).unwrap();
        let link = local.files().ingest_link(&sample, None).unwrap();
        fs::write(&sample, b"remote copy").unwrap();
        let remote_file = remote.files().ingest("copy", &sample, None).unwrap();
        let remote_root = remote.root().to_owned();
        let server = crate::test_http::Server::start(move |request, body| {
            respond(&remote_root, request, body)
        });
        let client = Client::builder().no_proxy().build().unwrap();
        sync_resources(&client, &server.url, "", &local, &mut |_| {}).unwrap();
        assert_eq!(
            fs::read(local_assets.join("download.png")).unwrap(),
            b"download"
        );
        assert_eq!(
            fs::read(remote_assets.join("upload.png")).unwrap(),
            b"upload"
        );
        assert_eq!(
            fs::read(copy_path(local.root(), &remote_file).unwrap()).unwrap(),
            b"remote copy"
        );
        assert_eq!(
            fs::read(copy_path(remote.root(), &local_file).unwrap()).unwrap(),
            b"local copy"
        );
        assert_eq!(
            remote.files().get(field(&link, "id")).unwrap().unwrap()["mode"],
            "link"
        );
        local_file["updatedAt"] = json!("9999-01-01T00:00:00.000Z");
        fs::write(
            copy_path(local.root(), &local_file).unwrap(),
            b"replacement",
        )
        .unwrap();
        local.files().upsert_metadata(&local_file).unwrap();
        sync_resources(&client, &server.url, "", &local, &mut |_| {}).unwrap();
        assert_eq!(
            fs::read(copy_path(remote.root(), &local_file).unwrap()).unwrap(),
            b"replacement"
        );
        let mut changed_remote = remote_file.clone();
        changed_remote["updatedAt"] = json!("9999-01-02T00:00:00.000Z");
        fs::write(
            copy_path(remote.root(), &changed_remote).unwrap(),
            b"remote replacement",
        )
        .unwrap();
        remote.files().upsert_metadata(&changed_remote).unwrap();
        sync_resources(&client, &server.url, "", &local, &mut |_| {}).unwrap();
        assert_eq!(
            fs::read(copy_path(local.root(), &changed_remote).unwrap()).unwrap(),
            b"remote replacement"
        );
        let folder = dir.join("folder");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("keep.txt"), b"keep").unwrap();
        let directory = local.files().ingest("copy", &folder, None).unwrap();
        assert!(sync_resources(&client, &server.url, "", &local, &mut |_| {})
            .unwrap_err()
            .contains("目录副本尚未同步"));
        assert!(local
            .root()
            .join(field(&directory, "storedPath"))
            .join("keep.txt")
            .is_file());
        drop(server);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn device_bindings_converge_in_both_directions_without_transmitting_link_previews() {
        let dir = std::env::temp_dir().join(format!("tie-resource-device-sync-{}", tie_local::new_page_id()));
        fs::create_dir_all(dir.join("local/pages")).unwrap();
        fs::create_dir_all(dir.join("remote/pages")).unwrap();
        let local = LocalWorkspace::open(&dir.join("local"), None).unwrap();
        let remote = LocalWorkspace::open(&dir.join("remote"), None).unwrap();
        let a = tie_local::identity::DeviceIdentity { id:"dev_a".into(), name:"A".into(), platform:"linux".into() };
        let b = tie_local::identity::DeviceIdentity { id:"dev_b".into(), name:"B".into(), platform:"windows".into() };
        let mut left = json!({ "id":"file_device", "mode":"link", "kind":"directory", "updatedAt":"2026-01-01T00:00:01Z", "preview":"private excerpt" });
        tie_local::bind_file_to_device(&mut left, &a, "/same/source", json!({ "type":"desktop", "desktopPath":"/same/source" }), "2026-01-01T00:00:01Z");
        let mut right = json!({ "id":"file_device", "mode":"link", "kind":"directory", "updatedAt":"2026-01-01T00:00:02Z" });
        tie_local::bind_file_to_device(&mut right, &b, "/same/source", json!({ "type":"desktop", "desktopPath":"/same/source" }), "2026-01-01T00:00:02Z");
        local.files().upsert_metadata(&left).unwrap();
        remote.files().upsert_metadata(&right).unwrap();
        let remote_root = remote.root().to_owned();
        let server = crate::test_http::Server::start(move |request, body| respond(&remote_root, request, body));
        let client = Client::builder().no_proxy().build().unwrap();
        sync_resources(&client, &server.url, "", &local, &mut |_| {}).unwrap();
        let merged = local.files().get("file_device").unwrap().unwrap();
        let upstream = remote.files().get("file_device").unwrap().unwrap();
        assert_eq!(merged["deviceBindings"], upstream["deviceBindings"]);
        assert_eq!(merged["deviceBindings"].as_object().unwrap().len(), 2);
        tie_local::bind_file_to_device(&mut right, &b, "D:\\Source", json!({ "type":"desktop", "desktopPath":"D:\\Source" }), "2026-01-01T00:00:04Z");
        right["updatedAt"] = json!("2026-01-01T00:00:04Z");
        tie_local::bind_file_to_device(&mut left, &a, "/new/source", json!({ "type":"desktop", "desktopPath":"/new/source" }), "2026-01-01T00:00:03Z");
        left["updatedAt"] = json!("2026-01-01T00:00:03Z");
        local.files().upsert_metadata(&left).unwrap();
        remote.files().upsert_metadata(&right).unwrap();
        sync_resources(&client, &server.url, "", &local, &mut |_| {}).unwrap();
        let merged = local.files().get("file_device").unwrap().unwrap();
        assert_eq!(tie_local::file_binding_path(&merged, "dev_a").as_deref(), Some("/new/source"));
        assert_eq!(tie_local::file_binding_path(&merged, "dev_b").as_deref(), Some("D:\\Source"));
        assert_eq!(merged["deviceBindings"], remote.files().get("file_device").unwrap().unwrap()["deviceBindings"]);
        assert!(remote.files().all_metadata().iter().all(|item| item.get("preview").is_none()));
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }
}
