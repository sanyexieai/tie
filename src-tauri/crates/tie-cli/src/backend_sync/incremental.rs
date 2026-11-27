use super::*;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const INDEX_FILE: &str = ".tie/sync-index.json";

pub(super) fn lock_workspace(root: &Path) -> Result<fs::File, String> {
    fs::create_dir_all(root.join(".tie")).map_err(|error| error.to_string())?;
    let file = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(root.join(".tie/backend-sync.lock")).map_err(|error| error.to_string())?;
    file.lock().map_err(|error| format!("无法锁定同步工作区：{error}"))?;
    Ok(file)
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct Manifest {
    version: u32,
    revision: String,
    pages: Vec<ResourceVersion>,
    reviews: Vec<ResourceVersion>,
    assets: Vec<ResourceVersion>,
    files: Vec<ResourceVersion>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ResourceVersion { id: String, version: String }

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct Versions {
    pages: BTreeMap<String, String>,
    reviews: BTreeMap<String, String>,
    assets: BTreeMap<String, String>,
    files: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
struct PageFile {
    path: String,
    markdown: String,
    meta: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct LocalIndex {
    pages: BTreeMap<String, PageFile>,
    reviews: BTreeMap<String, String>,
    assets: BTreeMap<String, String>,
    files: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct SyncIndex {
    target: String,
    revision: String,
    remote: Versions,
    local: LocalIndex,
    #[serde(default)] remote_asset_files: crate::resources_sync::AssetVersions,
    #[serde(default)] conflicts: BTreeMap<String, Option<PageProtectionConflict>>,
}

fn target_key(target: &BackendTarget) -> String {
    format!("{}\n{}", target.url.trim_end_matches('/'), target.workspace_id)
}

fn load_index(root: &Path, target: &BackendTarget) -> Result<SyncIndex, String> {
    let path = root.join(INDEX_FILE);
    if !path.is_file() { return Ok(SyncIndex::default()); }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let index: SyncIndex = serde_json::from_str(&raw).map_err(|error| format!("同步索引无效：{error}"))?;
    Ok(if index.target == target_key(target) { index } else { SyncIndex::default() })
}

fn save_index(root: &Path, index: &SyncIndex) -> Result<(), String> {
    let path = root.join(INDEX_FILE);
    fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
    let pending = path.with_extension("json.tmp");
    fs::write(&pending, serde_json::to_vec(index).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    fs::rename(pending, path).map_err(|error| error.to_string())
}

fn stamp(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() { return Ok(None); }
    let modified = metadata.modified().map_err(|error| error.to_string())?
        .duration_since(std::time::UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos();
    Ok(Some(format!("{}:{modified}", metadata.len())))
}

fn entries(directory: &Path) -> Result<Vec<PathBuf>, String> {
    match fs::read_dir(directory) {
        Ok(entries) => entries.map(|entry| entry.map(|entry| entry.path()).map_err(|error| error.to_string())).collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn folder_version(directory: &Path) -> Result<String, String> {
    fn visit(root: &Path, directory: &Path, files: &mut BTreeMap<String, String>) -> Result<(), String> {
        for path in entries(directory)? {
            if path.is_dir() { visit(root, &path, files)?; }
            else if let Some(version) = stamp(&path)? {
                files.insert(path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"), version);
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    visit(directory, directory, &mut files)?;
    serde_json::to_string(&files).map_err(|error| error.to_string())
}

fn resource_id(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix) && value.len() <= 160 && value.chars().all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn page_file(root: &Path, id: &str, path: &str) -> Result<Option<PageFile>, String> {
    let absolute = tie_local::resolve_workspace_file(root, path).ok_or("页面索引路径无效")?;
    let Some(markdown) = stamp(&absolute)? else { return Ok(None) };
    Ok(Some(PageFile { path: path.to_owned(), markdown, meta: stamp(&tie_local::page_meta_path(root, id))?.unwrap_or_default() }))
}

fn scan_local(ws: &LocalWorkspace, previous: &LocalIndex) -> Result<LocalIndex, String> {
    let root = ws.root();
    let mut result = LocalIndex::default();
    let mut known_paths = HashSet::new();
    for meta in entries(&root.join(".tie/meta"))? {
        let Some(id) = meta.file_name().and_then(|name| name.to_str()) else { continue };
        if !resource_id(id, "pg_") { continue; }
        let meta_stamp = stamp(&meta)?.unwrap_or_default();
        let path = if let Some(old) = previous.pages.get(id).filter(|old| old.meta == meta_stamp) {
            old.path.clone()
        } else {
            let raw = fs::read_to_string(&meta).map_err(|error| error.to_string())?;
            let Some(path) = raw.lines().find_map(|line| line.strip_prefix("file:").map(str::trim)) else { continue };
            path.to_owned()
        };
        if let Some(file) = page_file(root, id, &path)? {
            known_paths.insert(path);
            result.pages.insert(id.to_owned(), file);
        }
    }
    // Frontmatter-only files keep their cached identity until their own stat changes.
    for (id, old) in &previous.pages {
        if !old.meta.is_empty() || result.pages.contains_key(id) { continue; }
        if let Some(file) = page_file(root, id, &old.path)? {
            if file == *old {
                known_paths.insert(old.path.clone());
                result.pages.insert(id.clone(), file);
            }
        }
    }
    // External editors and old frontmatter-only pages may not have a sidecar yet.
    // Only those newly discovered files are parsed/adopted, not the whole library.
    for path in entries(&ws.pages_dir())? {
        if path.extension().and_then(|value| value.to_str()) != Some("md") { continue; }
        let relative = tie_local::workspace_relative(root, &path)?;
        if known_paths.contains(&relative) { continue; }
        let page = tie_local::open_or_adopt(root, &path, ws.default_source_id())?;
        let actual = tie_local::find_page_file(root, &page.id).ok_or("页面文件不存在")?;
        let relative = tie_local::workspace_relative(root, &actual)?;
        if let Some(file) = page_file(root, &page.id, &relative)? { result.pages.insert(page.id, file); }
    }
    for path in entries(&root.join(".tie/reviews"))? {
        let Some(id) = path.file_stem().and_then(|name| name.to_str()) else { continue };
        if path.extension().and_then(|value| value.to_str()) == Some("json") && resource_id(id, "pg_") {
            if let Some(version) = stamp(&path)? { result.reviews.insert(id.to_owned(), version); }
        }
    }
    for (directory, prefix, target) in [
        (".tie/assets", "pg_", &mut result.assets),
        (".tie/files", "file_", &mut result.files),
    ] {
        for path in entries(&root.join(directory))? {
            let Some(id) = path.file_name().and_then(|name| name.to_str()) else { continue };
            if path.is_dir() && resource_id(id, prefix) { target.insert(id.to_owned(), folder_version(&path)?); }
        }
    }
    Ok(result)
}

fn changed_ids<T: PartialEq>(before: &BTreeMap<String, T>, after: &BTreeMap<String, T>) -> BTreeSet<String> {
    before.keys().chain(after.keys()).filter(|id| before.get(*id) != after.get(*id)).cloned().collect()
}

fn fetch_manifest(client: &reqwest::blocking::Client, target: &BackendTarget, token: &str, previous: &SyncIndex) -> Result<Option<Manifest>, String> {
    let url = format!("{}/api/v1/workspaces/{}/sync/manifest", target.url.trim_end_matches('/'), target.workspace_id);
    let mut request = client.get(url).bearer_auth(token);
    if !previous.revision.is_empty() { request = request.query(&[("revision", &previous.revision)]); }
    let response = request.send().map_err(|error| format!("读取增量同步状态失败：{error}"))?;
    if response.status().as_u16() == 304 {
        if previous.revision.is_empty() { return Err("后台在首次同步时返回了无效的未变状态".into()); }
        return Ok(None);
    }
    if response.status().as_u16() == 404 { return Err("后台尚不支持增量同步，请更新后台后重试；本机数据已保留".into()); }
    if !response.status().is_success() { return Err(format!("读取增量同步状态失败：{}", response.status())); }
    let manifest: Manifest = response.json().map_err(|error| format!("增量同步状态无效：{error}"))?;
    if manifest.version != 1 || manifest.revision.is_empty() { return Err("增量同步协议版本无效".into()); }
    for (values, prefix) in [(&manifest.pages, "pg_"), (&manifest.reviews, "pg_"), (&manifest.assets, "pg_"), (&manifest.files, "file_")] {
        let mut ids = HashSet::new();
        if values.iter().any(|item| !resource_id(&item.id, prefix) || item.version.is_empty() || !ids.insert(&item.id)) {
            return Err("增量同步资源清单无效".into());
        }
    }
    Ok(Some(manifest))
}

impl Manifest {
    fn versions(&self) -> Versions {
        let map = |entries: &[ResourceVersion]| entries.iter().map(|item| (item.id.clone(), item.version.clone())).collect();
        Versions { pages: map(&self.pages), reviews: map(&self.reviews), assets: map(&self.assets), files: map(&self.files) }
    }
}

pub(super) fn remote_page(client: &reqwest::blocking::Client, target: &BackendTarget, token: &str, id: &str) -> Result<Option<Page>, String> {
    if !resource_id(id, "pg_") { return Err("页面 ID 无效".into()); }
    let url = format!("{}/api/v1/workspaces/{}/pages/{id}", target.url.trim_end_matches('/'), target.workspace_id);
    let response = client.get(url).bearer_auth(token).send().map_err(|error| error.to_string())?;
    if response.status().as_u16() == 404 { return Ok(None); }
    if !response.status().is_success() { return Err(format!("读取后台页面失败：{}", response.status())); }
    response.json().map(Some).map_err(|error| error.to_string())
}

fn acknowledge_pull(ws: &LocalWorkspace, expected: &Page, local: &mut LocalIndex) -> Result<Option<Page>, String> {
    let Some(path) = tie_local::find_page_file(ws.root(), &expected.id) else { return Ok(None) };
    let relative = tie_local::workspace_relative(ws.root(), &path)?;
    let before = page_file(ws.root(), &expected.id, &relative)?;
    let actual = ws.get_by_id(&expected.id)?;
    let after = page_file(ws.root(), &expected.id, &relative)?;
    if before == after && actual.as_ref().is_some_and(|page| same_content(page, expected) && page.updated_at == expected.updated_at) {
        if let Some(file) = after { local.pages.insert(expected.id.clone(), file); }
    }
    Ok(actual)
}

pub(super) fn sync(target: &BackendTarget, token: &str, ws: &LocalWorkspace, actor: &str, observe: &mut dyn FnMut(BackendSyncProgress)) -> Result<BackendSyncReport, String> {
    let _lock = lock_workspace(ws.root())?;
    let client = http_client()?;
    let old = load_index(ws.root(), target)?;
    let mut local_index = scan_local(ws, &old.local)?;
    let manifest = fetch_manifest(&client, target, token, &old)?;
    let revision = manifest.as_ref().map(|value| value.revision.clone()).unwrap_or_else(|| old.revision.clone());
    let remote_index = manifest.as_ref().map(Manifest::versions).unwrap_or_else(|| old.remote.clone());
    let local_page_changes = changed_ids(&old.local.pages, &local_index.pages);
    let mut page_ids = local_page_changes.clone();
    page_ids.extend(changed_ids(&old.remote.pages, &remote_index.pages));
    let mut assets = changed_ids(&old.local.assets, &local_index.assets);
    assets.extend(changed_ids(&old.remote.assets, &remote_index.assets));
    let mut reviews = changed_ids(&old.local.reviews, &local_index.reviews);
    reviews.extend(changed_ids(&old.remote.reviews, &remote_index.reviews));
    let local_file_changes = changed_ids(&old.local.files, &local_index.files);
    let remote_file_changes = changed_ids(&old.remote.files, &remote_index.files);
    let mut files = local_file_changes.clone();
    files.extend(remote_file_changes.iter().cloned());
    let changed = !page_ids.is_empty() || !assets.is_empty() || !reviews.is_empty() || !files.is_empty();
    let mut cursor = read_cursor(ws.root())?;
    let mut conflicts = old.conflicts.clone();
    let mut changed_pages = BTreeMap::new();
    let mut removed_page_ids = Vec::new();
    let mut pushed = 0;
    let mut pulled = 0;
    report_progress(observe, BackendSyncStage::Pages, 0, page_ids.len());
    for (index, id) in page_ids.iter().enumerate() {
        conflicts.remove(id);
        let local = ws.get_by_id(id)?;
        if local_page_changes.contains(id) { if let Some(page) = &local { changed_pages.insert(id.clone(), page.clone()); } }
        let remote = if remote_index.pages.contains_key(id) { remote_page(&client, target, token, id)? } else { None };
        if remote_index.pages.contains_key(id) && remote.is_none() { return Err("后台页面在同步期间变化，请重试".into()); }
        if let (Some(local), Some(remote)) = (&local, &remote) {
            if tie_local::is_encrypted_markdown(&local.markdown) != tie_local::is_encrypted_markdown(&remote.markdown) {
                conflicts.insert(id.clone(), Some(PageProtectionConflict { page_id: id.clone(), local_encrypted: tie_local::is_encrypted_markdown(&local.markdown), remote_encrypted: tie_local::is_encrypted_markdown(&remote.markdown), local_updated_at: local.updated_at.clone(), remote_updated_at: remote.updated_at.clone() }));
                report_progress(observe, BackendSyncStage::Pages, index + 1, page_ids.len());
                continue;
            }
        }
        if old.conflicts.contains_key(id) { assets.insert(id.clone()); reviews.insert(id.clone()); }
        if old.conflicts.contains_key(id) && local.as_ref().is_some_and(|local| remote.as_ref().is_none_or(|remote| !same_content(local, remote))) {
            if let (Some(local), Some(remote)) = (&local, &remote) { note_divergence(ws.root(), actor, local, remote); }
            conflicts.insert(id.clone(), None);
            report_progress(observe, BackendSyncStage::Pages, index + 1, page_ids.len());
            continue;
        }
        if remote.is_none() && old.remote.pages.contains_key(id) {
            if let Some(local) = &local {
                if local.deleted_at.is_some() && cursor.get(id).is_some_and(|mark| mark.local == local.updated_at)
                    && old.local.pages.get(id) == local_index.pages.get(id) {
                    tie_local::changes::with_change_context(tie_local::changes::current_origin(), None, true, || ws.purge_page(id, false))?;
                    cursor.remove(id); local_index.pages.remove(id); changed_pages.remove(id); removed_page_ids.push(id.clone()); pulled += 1;
                } else { conflicts.insert(id.clone(), None); }
            } else { cursor.remove(id); }
        } else if let (None, Some(remote)) = (&local, &remote) {
            if remote.deleted_at.is_some() && cursor.get(id).is_some_and(|mark| mark.remote == remote.updated_at)
                && (old.revision.is_empty() || old.remote.pages.get(id) == remote_index.pages.get(id)) {
                let response = client.post(format!("{}/api/v1/workspaces/{}/pages", target.url.trim_end_matches('/'), target.workspace_id))
                    .bearer_auth(token).header("x-tie-replication", "1")
                    .header("x-tie-origin", tie_local::changes::origin_header(&tie_local::changes::current_origin())?)
                    .json(&json!({ "pageIds": [id] })).send().map_err(|error| error.to_string())?;
                if !response.status().is_success() { return Err(format!("永久删除尚未同步：{}", response.status())); }
                cursor.remove(id); pushed += 1;
            } else {
                pull_page(ws, remote, None)?;
                if let Some(page) = acknowledge_pull(ws, remote, &mut local_index)? { changed_pages.insert(id.clone(), page); }
                cursor.insert(id.clone(), entry(remote, remote)); pulled += 1;
                assets.insert(id.clone()); reviews.insert(id.clone());
            }
        } else {
            let action = if old.local.pages.contains_key(id) && old.remote.pages.contains_key(id)
                && local.as_ref().zip(remote.as_ref()).is_some_and(|(local, remote)| !same_content(local, remote)) {
                let local_changed = old.local.pages.get(id) != local_index.pages.get(id);
                let remote_changed = old.remote.pages.get(id) != remote_index.pages.get(id);
                match (local_changed, remote_changed) {
                    (true, false) => Action::Push,
                    (false, true) => Action::Pull,
                    (true, true) => Action::Conflict,
                    (false, false) => plan(local.as_ref(), remote.as_ref(), cursor.get(id)),
                }
            } else { plan(local.as_ref(), remote.as_ref(), cursor.get(id)) };
            match action {
                Action::Skip => if let (Some(local), Some(remote)) = (&local, &remote) { cursor.insert(id.clone(), entry(local, remote)); },
                Action::Push => {
                    let local = local.as_ref().ok_or("本地页面不存在")?;
                    match put_remote(&client, target, token, local, remote.as_ref()) {
                        Ok(saved) => { cursor.insert(id.clone(), entry(local, &saved)); pushed += 1; assets.insert(id.clone()); reviews.insert(id.clone()); }
                        Err(error) if error == "conflict" => { let fresh = get_remote_page(&client, target, token, id)?; note_divergence(ws.root(), actor, local, &fresh); conflicts.insert(id.clone(), None); }
                        Err(error) => return Err(error),
                    }
                }
                Action::Pull => {
                    let remote = remote.as_ref().ok_or("后台页面不存在")?;
                    pull_page(ws, remote, local.as_ref())?;
                    if let Some(page) = acknowledge_pull(ws, remote, &mut local_index)? { changed_pages.insert(id.clone(), page); }
                    cursor.insert(id.clone(), entry(remote, remote)); pulled += 1; reviews.insert(id.clone());
                }
                Action::Conflict => if let (Some(local), Some(remote)) = (&local, &remote) { note_divergence(ws.root(), actor, local, remote); conflicts.insert(id.clone(), None); reviews.insert(id.clone()); },
            }
        }
        report_progress(observe, BackendSyncStage::Pages, index + 1, page_ids.len());
    }
    let blocked: HashSet<_> = conflicts.iter().filter_map(|(id, value)| (value.is_some() || !remote_index.pages.contains_key(id)).then_some(id.clone())).collect();
    assets.retain(|id| !blocked.contains(id));
    reviews.retain(|id| !blocked.contains(id));
    let asset_page_ids = assets.iter().cloned().collect();
    let file_ids = files.iter().cloned().collect();
    let mut remote_asset_files = old.remote_asset_files.clone();
    crate::resources_sync::sync_selected(&client, &format!("{}/api/v1/workspaces/{}", target.url.trim_end_matches('/'), target.workspace_id), token, ws, crate::resources_sync::ResourcePlan {
        assets, files, previous_assets: &old.local.assets, remote_assets: &mut remote_asset_files,
        local_file_changes, remote_file_changes, local_assets: &mut local_index.assets, local_files: &mut local_index.files,
    }, observe)?;
    let mut review_page_ids = Vec::new();
    report_progress(observe, BackendSyncStage::Reviews, 0, reviews.len());
    for (index, id) in reviews.iter().enumerate() {
        if exchange_reviews(&client, target, token, ws.root(), id)? { review_page_ids.push(id.clone()); }
        report_progress(observe, BackendSyncStage::Reviews, index + 1, reviews.len());
    }
    let local_versions = LocalVersions {
        pages: local_index.pages.iter().map(|(id, page)| Ok((id.clone(), serde_json::to_string(page).map_err(|error| error.to_string())?))).collect::<Result<_, String>>()?,
        reviews: local_index.reviews.clone(), assets: local_index.assets.clone(), files: local_index.files.clone(),
    };
    write_cursor(ws.root(), &cursor)?;
    save_index(ws.root(), &SyncIndex { target: target_key(target), revision, remote: remote_index, local: local_index, remote_asset_files, conflicts: conflicts.clone() })?;
    let protection_conflicts: Vec<_> = conflicts.values().filter_map(Clone::clone).collect();
    let message = if !protection_conflicts.is_empty() { "[PROTECTION_REQUIRED] 本地与服务器的页面保护状态不同，请解锁并对齐保护状态后重试同步".to_owned() }
        else if !conflicts.is_empty() { "本地与服务器内容存在冲突，已保留两边版本".to_owned() } else { String::new() };
    Ok(BackendSyncReport { mode: if conflicts.is_empty() { "synced" } else { "conflict" }.into(), message, peer: "backend".into(), url: target.url.clone(), workspace_id: target.workspace_id.clone(), pushed, pulled, conflicts: conflicts.keys().cloned().collect(), protection_conflicts, user_email: String::new(), changed, changed_pages: changed_pages.into_values().collect(), removed_page_ids, review_page_ids, asset_page_ids, file_ids, local_versions: Some(local_versions) })
}

#[cfg(test)]
pub(crate) fn fixture_response(root: &Path, request: &str) -> Option<(u16, Vec<u8>)> {
    use std::hash::{Hash, Hasher};
    let path = request.split_whitespace().nth(1)?;
    if !request.starts_with("GET ") { return None; }
    let ws = LocalWorkspace::open(root, Some("src_test")).unwrap();
    if path.starts_with("/sync/manifest") {
        let local = scan_local(&ws, &LocalIndex::default()).unwrap();
        let page_versions: BTreeMap<_, _> = local.pages.iter().map(|(id, file)| (id.clone(), serde_json::to_string(file).unwrap())).collect();
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        serde_json::to_string(&(&page_versions, &local.reviews, &local.assets, &local.files)).unwrap().hash(&mut hash);
        let revision = format!("{:x}", hash.finish());
        if path.split_once("?revision=").is_some_and(|(_, previous)| previous == revision) { return Some((304, Vec::new())); }
        let entries = |values: &BTreeMap<String, String>| values.iter().map(|(id, version)| json!({ "id": id, "version": version })).collect::<Vec<_>>();
        return Some((200, serde_json::to_vec(&json!({ "version": 1, "revision": revision, "pages": entries(&page_versions), "reviews": entries(&local.reviews), "assets": entries(&local.assets), "files": entries(&local.files) })).unwrap()));
    }
    let pieces: Vec<_> = path.trim_start_matches('/').split('/').collect();
    if let ["pages", id] = pieces.as_slice() {
        return Some(match ws.get_by_id(id).unwrap() { Some(page) => (200, serde_json::to_vec(&page).unwrap()), None => (404, b"{}".to_vec()) });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn setup() -> (PathBuf, LocalWorkspace, LocalWorkspace) {
        let dir = std::env::temp_dir().join(format!("tie-incremental-{}", tie_local::new_page_id()));
        let local = LocalWorkspace::init(dir.join("local"), "src_test").unwrap();
        let remote = LocalWorkspace::init(dir.join("remote"), "src_test").unwrap();
        (dir, local, remote)
    }

    fn serve(remote: &LocalWorkspace) -> (crate::test_http::Server, BackendTarget, Arc<Mutex<Vec<String>>>) {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let root = remote.root().to_owned();
        let server = crate::test_http::Server::start(move |request, body| {
            let request = request.replace("/api/v1/workspaces/ws_test", "");
            recorded.lock().unwrap().push(request.clone());
            if let Some(response) = fixture_response(&root, &request) { return response; }
            let parts: Vec<_> = request.split_whitespace().collect();
            let path: Vec<_> = parts[1].split('?').next().unwrap().trim_start_matches('/').split('/').collect();
            match path.as_slice() {
                ["pages", _id] if parts[0] == "PUT" => {
                    let saved = tie_local::changes::with_change_context(tie_local::changes::current_origin(), None, true,
                        || save_page_to_root(&root, serde_json::from_slice(body).unwrap(), None)).unwrap();
                    (200, serde_json::to_vec(&saved).unwrap())
                }
                ["pages", id, "reviews"] => {
                    if parts[0] == "PUT" { write_reviews(&root, id, &serde_json::from_slice(body).unwrap()).unwrap(); }
                    (200, serde_json::to_vec(&read_review_file(&root, id)).unwrap())
                }
                ["pages"] if parts[0] == "POST" => {
                    let ws = LocalWorkspace::open(&root, Some("src_test")).unwrap();
                    for id in serde_json::from_slice::<Value>(body).unwrap()["pageIds"].as_array().unwrap() { ws.purge_page(id.as_str().unwrap(), false).unwrap(); }
                    (204, Vec::new())
                }
                _ => crate::resources_sync::tests::respond(&root, &request, body),
            }
        });
        let target = BackendTarget { url: server.url.clone(), workspace_id: "ws_test".into() };
        (server, target, requests)
    }

    fn align(target: &BackendTarget, ws: &LocalWorkspace) -> BackendSyncReport {
        sync(target, "", ws, "test", &mut |_| {}).unwrap()
    }

    fn settle(target: &BackendTarget, ws: &LocalWorkspace) {
        for _ in 0..4 { if !align(target, ws).changed { return; } }
        panic!("incremental sync did not settle after its own writes");
    }

    fn write(ws: &LocalWorkspace, id: &str, body: &str, stamp: &str) {
        let page = Page { id: id.into(), title: id.into(), markdown: body.into(), icon: String::new(), tags: Vec::new(), parent_id: None, sort_key: 0,
            created_at: stamp.into(), updated_at: stamp.into(), deleted_at: None, storage_source_id: "src_test".into(), storage_source_ids: vec!["src_test".into()] };
        save_page_to_root(ws.root(), page, None).unwrap();
    }

    #[test]
    fn idle_and_unchanged_conflicts_only_read_the_manifest() {
        for conflict in [false, true] {
            let (dir, local, remote) = setup();
            write(&local, "pg_first", "local original", "2026-01-01T00:00:00Z");
            write(&remote, "pg_first", if conflict { "remote original" } else { "local original" }, "2026-01-01T00:00:00Z");
            let (server, target, requests) = serve(&remote);
            settle(&target, &local);
            requests.lock().unwrap().clear();
            for _ in 0..3 {
                let report = align(&target, &local);
                assert!(!report.changed);
                assert_eq!(report.conflicts.len(), usize::from(conflict));
                assert!(report.changed_pages.is_empty());
            }
            let actual = requests.lock().unwrap().clone();
            assert_eq!(actual.len(), 3);
            assert!(actual.iter().all(|request| request.starts_with("GET /sync/manifest?revision=")));
            drop(server); fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn edits_and_discussions_only_fetch_the_affected_resource() {
        let (dir, local, remote) = setup();
        for id in ["pg_first", "pg_second"] { write(&local, id, id, "2026-01-01T00:00:00Z"); }
        let (server, target, requests) = serve(&remote);
        settle(&target, &local);
        write(&local, "pg_first", "only first changed", "2026-01-02T00:00:00Z");
        requests.lock().unwrap().clear();
        let report = align(&target, &local);
        assert_eq!(report.pushed, 1);
        assert_eq!(report.changed_pages.iter().map(|page| page.id.as_str()).collect::<Vec<_>>(), ["pg_first"]);
        assert!(requests.lock().unwrap().iter().all(|request| !request.contains("/pg_second") && !request.starts_with("GET /pages ")));
        settle(&target, &local);
        add_opinion(local.root(), "pg_second", "op_second", "test", "note", "", "only discussion changed").unwrap();
        requests.lock().unwrap().clear();
        let report = align(&target, &local);
        assert!(report.changed_pages.is_empty());
        assert_eq!(report.review_page_ids, ["pg_second"]);
        let actual = requests.lock().unwrap().clone();
        assert!(actual.iter().any(|request| request.starts_with("GET /pages/pg_second/reviews ")));
        assert!(actual.iter().all(|request| !request.starts_with("GET /pages/pg_second ") && !request.contains("/pg_first") && !request.contains("/assets")));
        drop(server); fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn same_named_asset_updates_are_incremental_and_conflicts_keep_both_bytes() {
        let (dir, local, remote) = setup();
        write(&local, "pg_assets", "images", "2026-01-01T00:00:00Z");
        let local_assets = tie_local::page_asset_dir(local.root(), "pg_assets");
        fs::create_dir_all(&local_assets).unwrap();
        fs::write(local_assets.join("first.png"), b"first").unwrap();
        fs::write(local_assets.join("second.png"), b"second").unwrap();
        let (server, target, requests) = serve(&remote);
        settle(&target, &local);
        fs::write(local_assets.join("first.png"), b"local replacement").unwrap();
        requests.lock().unwrap().clear();
        align(&target, &local);
        let remote_assets = tie_local::page_asset_dir(remote.root(), "pg_assets");
        assert_eq!(fs::read(remote_assets.join("first.png")).unwrap(), b"local replacement");
        assert!(requests.lock().unwrap().iter().all(|request| !request.contains("/assets/second.png") && !request.starts_with("GET /pages/pg_assets ")));
        settle(&target, &local);
        fs::write(remote_assets.join("first.png"), b"remote replacement").unwrap();
        requests.lock().unwrap().clear();
        align(&target, &local);
        assert_eq!(fs::read(local_assets.join("first.png")).unwrap(), b"remote replacement");
        assert!(requests.lock().unwrap().iter().all(|request| !request.contains("/assets/second.png")));
        settle(&target, &local);
        fs::write(remote_assets.join("first.png"), b"remote conflict").unwrap();
        fs::write(local_assets.join("first.png"), b"local conflict").unwrap();
        assert!(sync(&target, "", &local, "test", &mut |_| {}).unwrap_err().contains("都已修改"));
        assert_eq!(fs::read(local_assets.join("first.png")).unwrap(), b"local conflict");
        assert_eq!(fs::read(remote_assets.join("first.png")).unwrap(), b"remote conflict");
        drop(server); fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn old_backend_is_an_explicit_error_without_a_full_content_fallback() {
        let (dir, local, _remote) = setup();
        write(&local, "pg_local", "preserved", "2026-01-01T00:00:00Z");
        let before = fs::read(local.root().join("pages/pg_local.md")).unwrap();
        let server = crate::test_http::Server::start(|request, _| {
            assert!(request.starts_with("GET /api/v1/workspaces/ws_test/sync/manifest "));
            (404, b"{}".to_vec())
        });
        let target = BackendTarget { url: server.url.clone(), workspace_id: "ws_test".into() };
        assert!(sync(&target, "", &local, "test", &mut |_| {}).unwrap_err().contains("更新后台"));
        assert_eq!(fs::read(local.root().join("pages/pg_local.md")).unwrap(), before);
        assert!(!local.root().join(INDEX_FILE).exists());
        drop(server); fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remote_permanent_deletion_only_removes_unchanged_tracked_trash() {
        for (trashed, edited) in [(true, false), (true, true), (false, false)] {
            let (dir, local, remote) = setup();
            write(&local, "pg_delete", "original", "2026-01-01T00:00:00Z");
            let mut page = local.get_by_id("pg_delete").unwrap().unwrap();
            if trashed { page.deleted_at = Some("2026-01-01T00:00:00Z".into()); }
            save_page_to_root(local.root(), page.clone(), None).unwrap();
            save_page_to_root(remote.root(), page, None).unwrap();
            let (server, target, _) = serve(&remote);
            settle(&target, &local);
            if edited {
                let mut page = local.get_by_id("pg_delete").unwrap().unwrap();
                page.markdown = "offline edit must survive".into();
                page.updated_at = "2026-02-01T00:00:00Z".into();
                save_page_to_root(local.root(), page, None).unwrap();
            }
            remote.purge_page("pg_delete", true).unwrap();
            let report = align(&target, &local);
            if trashed && !edited {
                assert!(local.get_by_id("pg_delete").unwrap().is_none());
                assert_eq!(report.removed_page_ids, ["pg_delete"]);
                assert!(!read_cursor(local.root()).unwrap().contains_key("pg_delete"));
            } else {
                assert_eq!(report.conflicts, ["pg_delete"]);
                assert!(local.get_by_id("pg_delete").unwrap().is_some());
                if edited { assert_eq!(local.get_by_id("pg_delete").unwrap().unwrap().markdown, "offline edit must survive"); }
            }
            assert!(remote.get_by_id("pg_delete").unwrap().is_none());
            drop(server); fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn external_markdown_edits_use_versions_even_when_the_sidecar_timestamp_is_unchanged() {
        let (dir, local, remote) = setup();
        write(&local, "pg_external", "original", "2026-01-01T00:00:00Z");
        let (server, target, _) = serve(&remote);
        settle(&target, &local);
        let path = tie_local::find_page_file(local.root(), "pg_external").unwrap();
        fs::write(&path, b"external editor changed the body").unwrap();
        let report = align(&target, &local);
        assert_eq!(report.pushed, 1);
        assert_eq!(remote.get_by_id("pg_external").unwrap().unwrap().markdown, "external editor changed the body");
        settle(&target, &local);
        fs::write(&path, b"offline external editor changed it again").unwrap();
        write(&remote, "pg_external", "remote editor also changed it", "2026-02-01T00:00:00Z");
        let report = align(&target, &local);
        assert_eq!(report.conflicts, ["pg_external"]);
        assert_eq!(fs::read(&path).unwrap(), b"offline external editor changed it again");
        assert_eq!(remote.get_by_id("pg_external").unwrap().unwrap().markdown, "remote editor also changed it");
        drop(server); fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_new_local_edit_does_not_overwrite_an_unresolved_remote_conflict() {
        let (dir, local, remote) = setup();
        write(&local, "pg_conflict", "local draft", "2026-01-01T00:00:00Z");
        write(&remote, "pg_conflict", "remote draft", "2026-01-02T00:00:00Z");
        let (server, target, requests) = serve(&remote);
        settle(&target, &local);
        write(&local, "pg_conflict", "newer local draft", "2026-02-01T00:00:00Z");
        requests.lock().unwrap().clear();
        let report = align(&target, &local);
        assert_eq!(report.conflicts, ["pg_conflict"]);
        assert_eq!(report.pushed, 0);
        assert_eq!(local.get_by_id("pg_conflict").unwrap().unwrap().markdown, "newer local draft");
        assert_eq!(remote.get_by_id("pg_conflict").unwrap().unwrap().markdown, "remote draft");
        assert!(requests.lock().unwrap().iter().all(|request| !request.starts_with("PUT /pages/pg_conflict ")));
        drop(server); fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_manifest_never_becomes_an_empty_remote_workspace() {
        for status in [200, 304] {
            let (dir, local, _) = setup();
            write(&local, "pg_preserved", "preserved", "2026-01-01T00:00:00Z");
            let server = crate::test_http::Server::start(move |request, _| {
                assert!(request.contains("/sync/manifest"));
                (status, if status == 200 { br#"{"version":1,"revision":"incomplete"}"#.to_vec() } else { Vec::new() })
            });
            let target = BackendTarget { url: server.url.clone(), workspace_id: "ws_test".into() };
            assert!(sync(&target, "", &local, "test", &mut |_| {}).is_err());
            assert_eq!(local.get_by_id("pg_preserved").unwrap().unwrap().markdown, "preserved");
            assert!(!local.root().join(INDEX_FILE).exists());
            assert!(!local.root().join(CURSOR_FILE).exists());
            drop(server); fs::remove_dir_all(dir).unwrap();
        }
    }
}
