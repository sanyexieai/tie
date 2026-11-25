//! Align a local workspace with one Tie backend workspace.
//! Page bytes stay in tie-local. This module only decides push, pull, or conflict.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::Path,
    sync::Mutex,
    time::Duration,
};
use tie_local::{save_page_to_root, LocalWorkspace, Page};

const SYNC_FILE: &str = ".tie/sync.json";
const STATUS_FILE: &str = ".tie/sync-status.json";
const CURSOR_FILE: &str = ".tie/sync-cursor.json";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendSyncReport {
    pub mode: String,
    pub message: String,
    pub peer: String,
    pub url: String,
    pub workspace_id: String,
    pub pushed: u32,
    pub pulled: u32,
    pub conflicts: Vec<String>,
    pub user_email: String,
}

#[derive(Clone, Debug)]
struct BackendTarget {
    url: String,
    workspace_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CursorEntry {
    local: String,
    remote: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Push,
    Pull,
    Skip,
}

pub fn enable(ws: &LocalWorkspace, url: &str, workspace_id: &str) -> Result<BackendSyncReport, String> {
    write_config(ws.root(), url, workspace_id)?;
    sync_workspace(ws)
}

pub fn login(url: &str, email: &str, password: &str) -> Result<serde_json::Value, String> {
    authenticate(url, email, password, None, false)
}

pub fn register(url: &str, email: &str, password: &str, name: &str) -> Result<serde_json::Value, String> {
    authenticate(url, email, password, Some(name), true)
}

pub fn logout() -> Result<serde_json::Value, String> {
    tie_local::backend_session::clear_session()?;
    Ok(json!({ "loggedIn": false }))
}

fn authenticate(
    url: &str,
    email: &str,
    password: &str,
    name: Option<&str>,
    register: bool,
) -> Result<serde_json::Value, String> {
    let endpoint = normalize_endpoint(url)?;
    let email = email.trim().to_owned();
    if email.is_empty() || password.len() < 6 {
        return Err(if register {
            "邮箱或密码无效".to_owned()
        } else {
            "请填写用户名或邮箱，以及至少 6 位密码".to_owned()
        });
    }
    let client = http_client()?;
    let path = if register { "/api/v1/auth/register" } else { "/api/v1/auth/login" };
    let body = if register {
        json!({ "email": email, "password": password, "name": name.unwrap_or("").trim() })
    } else {
        json!({ "email": email, "password": password })
    };
    let response = client
        .post(format!("{endpoint}{path}"))
        .json(&body)
        .send()
        .map_err(|error| format!("无法连接后台：{error}"))?;
    let status = response.status();
    let text = response.text().map_err(|error| error.to_string())?;
    if !status.is_success() {
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|value| value.get("message").and_then(|item| item.as_str()).map(str::to_owned))
            .unwrap_or_else(|| format!("登录失败：{status}"));
        return Err(message);
    }
    let parsed: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let token = parsed
        .get("accessToken")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    let user = parsed.get("user").cloned().unwrap_or(Value::Null);
    let user_id = user.get("id").and_then(|item| item.as_str()).unwrap_or("").to_owned();
    let user_email = user.get("email").and_then(|item| item.as_str()).unwrap_or(&email).to_owned();
    let user_name = user.get("name").and_then(|item| item.as_str()).unwrap_or("").to_owned();
    let refresh_token = parsed
        .get("refreshToken")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    let access_expires_at = parsed
        .get("accessExpiresAt")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    if token.is_empty() || user_id.is_empty() {
        return Err("后台没有返回登录会话".to_owned());
    }
    tie_local::backend_session::write_session(&tie_local::backend_session::BackendSession {
        endpoint: endpoint.clone(),
        access_token: token,
        refresh_token,
        access_expires_at,
        user_id: user_id.clone(),
        email: user_email.clone(),
        name: user_name.clone(),
    })?;
    Ok(json!({
        "loggedIn": true,
        "endpoint": endpoint,
        "userId": user_id,
        "email": user_email,
        "name": user_name,
    }))
}

pub fn sync_workspace(ws: &LocalWorkspace) -> Result<BackendSyncReport, String> {
    let target = read_config(ws.root())?.ok_or("未配置后台。请指定 --backend-url 和 --backend-workspace")?;
    let session = ensure_session(false)?;
    let result = sync_as_user(&target, &session, ws);
    match &result {
        Ok(report) => write_status(ws.root(), report),
        Err(message) => write_status(
            ws.root(),
            &BackendSyncReport {
                mode: "error".into(),
                message: message.clone(),
                peer: "backend".into(),
                url: target.url.clone(),
                workspace_id: target.workspace_id.clone(),
                pushed: 0,
                pulled: 0,
                conflicts: Vec::new(),
                user_email: session.email.clone(),
            },
        ),
    }
    result
}

fn sync_as_user(
    target: &BackendTarget,
    session: &tie_local::backend_session::BackendSession,
    ws: &LocalWorkspace,
) -> Result<BackendSyncReport, String> {
    if normalize_endpoint(&session.endpoint)? != normalize_endpoint(&target.url)? {
        return Err("当前登录的后台和这个工作区配置的后台不是同一台".to_owned());
    }
    let client = http_client()?;
    let me = fetch_me(&client, session)?;
    let owned = list_owned_workspaces(&client, session)?;
    if !owned.iter().any(|id| id == &target.workspace_id) {
        return Err(format!(
            "工作区 {} 不属于当前用户 {}",
            target.workspace_id, me.email
        ));
    }
    let actor = if session.name.trim().is_empty() {
        me.email.clone()
    } else {
        session.name.clone()
    };
    let mut report = sync_with(target, &session.access_token, ws, &actor)?;
    report.user_email = me.email;
    Ok(report)
}

fn sync_with(target: &BackendTarget, token: &str, ws: &LocalWorkspace, actor: &str) -> Result<BackendSyncReport, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;
    let remote_pages = list_remote(&client, target, token)?;
    let local_pages = ws.load_all(true)?;
    let mut cursor = read_cursor(ws.root())?;
    let mut remote_by_id: HashMap<String, Page> = remote_pages
        .into_iter()
        .map(|page| (page.id.clone(), page))
        .collect();
    let mut pushed = 0u32;
    let mut pulled = 0u32;
    let conflicts = Vec::new();

    for local in &local_pages {
        let remote = remote_by_id.remove(&local.id);
        match plan(Some(local), remote.as_ref(), cursor.get(&local.id)) {
            Action::Skip => {
                if let Some(remote) = remote.as_ref() {
                    cursor.insert(local.id.clone(), entry(local, remote));
                }
            }
            Action::Push => {
                if let Some(remote) = remote.as_ref() {
                    if both_edited(local, remote, cursor.get(&local.id)) {
                        keep_newer(ws.root(), actor, local, remote);
                    }
                }
                match put_remote(&client, target, token, local, remote.as_ref()) {
                Ok(saved) => {
                    cursor.insert(local.id.clone(), entry(local, &saved));
                    pushed += 1;
                }
                Err(error) if error == "conflict" => {
                    let fresh = get_remote_page(&client, target, token, &local.id)?;
                    keep_newer(ws.root(), actor, local, &fresh);
                    if local.updated_at > fresh.updated_at {
                        let saved = put_remote(&client, target, token, local, None)?;
                        cursor.insert(local.id.clone(), entry(local, &saved));
                        pushed += 1;
                    } else {
                        pull_page(ws, &fresh, Some(local))?;
                        cursor.insert(fresh.id.clone(), entry(&fresh, &fresh));
                        pulled += 1;
                    }
                    let _ = exchange_reviews(&client, target, token, ws.root(), &local.id);
                }
                Err(error) => return Err(error),
            }
            }
            Action::Pull => {
                if let Some(remote) = remote {
                    if both_edited(local, &remote, cursor.get(&local.id)) {
                        keep_newer(ws.root(), actor, local, &remote);
                    }
                    pull_page(ws, &remote, Some(local))?;
                    cursor.insert(remote.id.clone(), entry(&remote, &remote));
                    let _ = exchange_reviews(&client, target, token, ws.root(), &remote.id);
                    pulled += 1;
                }
            }
        }
    }

    for remote in remote_by_id.into_values() {
        match plan(None, Some(&remote), cursor.get(&remote.id)) {
            Action::Pull | Action::Skip => {
                pull_page(ws, &remote, None)?;
                cursor.insert(remote.id.clone(), entry(&remote, &remote));
                let _ = exchange_reviews(&client, target, token, ws.root(), &remote.id);
                pulled += 1;
            }
            Action::Push => {}
        }
    }

    write_cursor(ws.root(), &cursor)?;
    for page_id in review_page_ids(ws.root()) {
        let _ = exchange_reviews(&client, target, token, ws.root(), &page_id);
    }
    let mode = if conflicts.is_empty() { "synced" } else { "conflict" };
    let message = if conflicts.is_empty() {
        String::new()
    } else {
        format!("这些页面在本地和后台都改过，未覆盖：{}", conflicts.join("、"))
    };
    Ok(BackendSyncReport {
        mode: mode.into(),
        message,
        peer: "backend".into(),
        url: target.url.clone(),
        workspace_id: target.workspace_id.clone(),
        pushed,
        pulled,
        conflicts,
        user_email: String::new(),
    })
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())
}

static SESSION_REFRESH: Mutex<()> = Mutex::new(());

struct SessionFileLock(std::path::PathBuf);

impl Drop for SessionFileLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn lock_session_file() -> Result<SessionFileLock, String> {
    let path = tie_local::backend_session::app_data_dir()?.join("backend-session.lock");
    for _ in 0..40 {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                drop(file);
                return Ok(SessionFileLock(path));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(25)),
        }
    }
    let _ = fs::remove_file(&path);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    Ok(SessionFileLock(path))
}

fn session_due(session: &tie_local::backend_session::BackendSession, force: bool) -> bool {
    if session.refresh_token.trim().is_empty() {
        return false;
    }
    if force || session.access_expires_at.trim().is_empty() {
        return true;
    }
    session.access_expires_at.as_str() <= iso_in(120).as_str()
}

fn rotate_session(
    session: &tie_local::backend_session::BackendSession,
) -> Result<tie_local::backend_session::BackendSession, String> {
    let client = http_client()?;
    let response = client
        .post(format!(
            "{}/api/v1/auth/refresh",
            session.endpoint.trim_end_matches('/')
        ))
        .json(&json!({ "refreshToken": session.refresh_token }))
        .send()
        .map_err(|error| format!("无法连接后台：{error}"))?;
    let status = response.status();
    let text = response.text().map_err(|error| error.to_string())?;
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("unauthorized".to_owned());
    }
    if !status.is_success() {
        return Err(format!("刷新登录失败：{status}"));
    }
    let parsed: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let access_token = parsed
        .get("accessToken")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_owned();
    let refresh_token = parsed
        .get("refreshToken")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_owned();
    let access_expires_at = parsed
        .get("accessExpiresAt")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_owned();
    if access_token.is_empty() || refresh_token.is_empty() {
        return Err("后台没有返回新的登录会话".to_owned());
    }
    let user = parsed.get("user").cloned().unwrap_or(Value::Null);
    Ok(tie_local::backend_session::BackendSession {
        endpoint: session.endpoint.clone(),
        access_token,
        refresh_token,
        access_expires_at,
        user_id: user
            .get("id")
            .and_then(|item| item.as_str())
            .unwrap_or(&session.user_id)
            .to_owned(),
        email: user
            .get("email")
            .and_then(|item| item.as_str())
            .unwrap_or(&session.email)
            .to_owned(),
        name: user
            .get("name")
            .and_then(|item| item.as_str())
            .unwrap_or(&session.name)
            .to_owned(),
    })
}

/// Read the one login file. Refresh the access token when it is near expiry.
pub fn ensure_session(force: bool) -> Result<tie_local::backend_session::BackendSession, String> {
    let _process = SESSION_REFRESH
        .lock()
        .map_err(|_| "登录会话忙".to_owned())?;
    let _file = lock_session_file()?;
    let Some(session) = tie_local::backend_session::read_session()? else {
        return Err("尚未登录后台。请先执行 tie sync login 或 tie sync register".to_owned());
    };
    if !session_due(&session, force) {
        return Ok(session);
    }
    match rotate_session(&session) {
        Ok(next) => {
            tie_local::backend_session::write_session(&next)?;
            Ok(next)
        }
        Err(message) if message == "unauthorized" => {
            tie_local::backend_session::clear_session()?;
            Err("登录已失效，请重新登录".to_owned())
        }
        Err(_) => Ok(session),
    }
}

pub fn session_value(session: &tie_local::backend_session::BackendSession) -> Value {
    json!({
        "endpoint": session.endpoint,
        "accessToken": session.access_token,
        "refreshToken": session.refresh_token,
        "accessExpiresAt": session.access_expires_at,
        "userId": session.user_id,
        "email": session.email,
        "name": session.name,
    })
}

pub fn load_session_for_ui() -> Result<Option<Value>, String> {
    match ensure_session(false) {
        Ok(session) => Ok(Some(session_value(&session))),
        Err(message) if message.contains("尚未登录") => Ok(None),
        Err(message) => Err(message),
    }
}

pub fn refresh_session_for_ui(force: bool) -> Result<Value, String> {
    Ok(session_value(&ensure_session(force)?))
}

fn normalize_endpoint(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/').to_owned();
    validate_target(&url, "ws_placeholder")?;
    Ok(url)
}

#[derive(Deserialize)]
struct Me {
    email: String,
}

fn fetch_me(
    client: &reqwest::blocking::Client,
    session: &tie_local::backend_session::BackendSession,
) -> Result<Me, String> {
    let response = client
        .get(format!("{}/api/v1/me", session.endpoint.trim_end_matches('/')))
        .bearer_auth(&session.access_token)
        .send()
        .map_err(|error| format!("无法连接后台：{error}"))?;
    let status = response.status();
    let text = response.text().map_err(|error| error.to_string())?;
    if status.as_u16() == 401 {
        return Err("登录已失效，请重新执行 tie sync login".to_owned());
    }
    if !status.is_success() {
        return Err(format!("读取当前用户失败：{status} {text}"));
    }
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

fn list_owned_workspaces(
    client: &reqwest::blocking::Client,
    session: &tie_local::backend_session::BackendSession,
) -> Result<Vec<String>, String> {
    let response = client
        .get(format!(
            "{}/api/v1/workspaces",
            session.endpoint.trim_end_matches('/')
        ))
        .bearer_auth(&session.access_token)
        .send()
        .map_err(|error| format!("无法连接后台：{error}"))?;
    let status = response.status();
    let text = response.text().map_err(|error| error.to_string())?;
    if status.as_u16() == 401 {
        return Err("登录已失效，请重新执行 tie sync login".to_owned());
    }
    if !status.is_success() {
        return Err(format!("读取工作区失败：{status} {text}"));
    }
    let workspaces: Vec<Value> = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    Ok(workspaces
        .into_iter()
        .filter_map(|item| item.get("id").and_then(|id| id.as_str()).map(str::to_owned))
        .collect())
}

fn plan(local: Option<&Page>, remote: Option<&Page>, cursor: Option<&CursorEntry>) -> Action {
    match (local, remote) {
        (None, None) => Action::Skip,
        (Some(_), None) => Action::Push,
        (None, Some(_)) => Action::Pull,
        (Some(local), Some(remote)) => {
            if same_content(local, remote) {
                return Action::Skip;
            }
            match cursor {
                Some(cursor) if local.updated_at == cursor.local && remote.updated_at != cursor.remote => {
                    Action::Pull
                }
                Some(cursor) if remote.updated_at == cursor.remote && local.updated_at != cursor.local => {
                    Action::Push
                }
                _ => prefer_newer(local, remote),
            }
        }
    }
}

fn prefer_newer(local: &Page, remote: &Page) -> Action {
    if local.updated_at > remote.updated_at {
        Action::Push
    } else {
        Action::Pull
    }
}

fn both_edited(local: &Page, remote: &Page, cursor: Option<&CursorEntry>) -> bool {
    if same_content(local, remote) {
        return false;
    }
    match cursor {
        Some(cursor) if local.updated_at == cursor.local && remote.updated_at != cursor.remote => false,
        Some(cursor) if remote.updated_at == cursor.remote && local.updated_at != cursor.local => false,
        _ => true,
    }
}

fn keep_newer(root: &Path, actor: &str, local: &Page, remote: &Page) {
    note_divergence(root, actor, local, remote);
    if local.updated_at > remote.updated_at {
        mark_resolution(root, &local.id, &local.updated_at, &remote.updated_at);
    } else {
        mark_resolution(root, &local.id, &remote.updated_at, &local.updated_at);
    }
}

fn same_content(left: &Page, right: &Page) -> bool {
    left.title == right.title
        && left.markdown == right.markdown
        && left.parent_id == right.parent_id
        && left.deleted_at == right.deleted_at
        && left.icon == right.icon
        && left.sort_key == right.sort_key
        && {
            let mut a = left.tags.clone();
            let mut b = right.tags.clone();
            a.sort();
            b.sort();
            a == b
        }
}

fn entry(local: &Page, remote: &Page) -> CursorEntry {
    CursorEntry {
        local: local.updated_at.clone(),
        remote: remote.updated_at.clone(),
    }
}

fn pull_page(ws: &LocalWorkspace, remote: &Page, local: Option<&Page>) -> Result<(), String> {
    let mut page = remote.clone();
    let source = local
        .map(|item| item.storage_source_id.clone())
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| ws.default_source_id().to_owned());
    page.storage_source_id = source.clone();
    page.storage_source_ids = vec![source];
    let expected = local.map(|item| item.updated_at.as_str());
    save_page_to_root(ws.root(), page, expected)?;
    Ok(())
}

fn list_remote(client: &reqwest::blocking::Client, target: &BackendTarget, token: &str) -> Result<Vec<Page>, String> {
    let url = format!(
        "{}/api/v1/workspaces/{}/pages",
        target.url.trim_end_matches('/'),
        target.workspace_id
    );
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("无法连接后台：{error}"))?;
    let status = response.status();
    let text = response.text().map_err(|error| error.to_string())?;
    if status.as_u16() == 401 {
        return Err("登录已失效，请重新执行 tie sync login".to_owned());
    }
    if !status.is_success() {
        return Err(format!("读取后台页面失败：{status} {text}"));
    }
    serde_json::from_str(&text).map_err(|error| format!("后台页面无法解析：{error}"))
}

fn get_remote_page(
    client: &reqwest::blocking::Client,
    target: &BackendTarget,
    token: &str,
    page_id: &str,
) -> Result<Page, String> {
    let url = format!(
        "{}/api/v1/workspaces/{}/pages/{}",
        target.url.trim_end_matches('/'),
        target.workspace_id,
        page_id
    );
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("无法连接后台：{error}"))?;
    let status = response.status();
    let text = response.text().map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("读取后台页面失败：{status} {text}"));
    }
    serde_json::from_str(&text).map_err(|error| format!("后台页面无法解析：{error}"))
}

fn put_remote(
    client: &reqwest::blocking::Client,
    target: &BackendTarget,
    token: &str,
    local: &Page,
    remote: Option<&Page>,
) -> Result<Page, String> {
    let url = format!(
        "{}/api/v1/workspaces/{}/pages/{}",
        target.url.trim_end_matches('/'),
        target.workspace_id,
        local.id
    );
    let mut request = client.put(url).bearer_auth(token).json(local);
    if let Some(remote) = remote {
        request = request.header("if-unmodified-since", &remote.updated_at);
    }
    let response = request
        .send()
        .map_err(|error| format!("无法连接后台：{error}"))?;
    let status = response.status();
    let text = response.text().map_err(|error| error.to_string())?;
    if status.as_u16() == 409 {
        return Err("conflict".to_owned());
    }
    if status.as_u16() == 401 {
        return Err("登录已失效，请重新执行 tie sync login".to_owned());
    }
    if !status.is_success() {
        return Err(format!("写入后台失败：{status} {text}"));
    }
    serde_json::from_str(&text).map_err(|error| format!("后台响应无法解析：{error}"))
}

pub struct McpHttpTarget {
    pub url: String,
    pub workspace_id: String,
}

/// Backend address recorded in the workspace, when this folder syncs to one.
pub fn mcp_http_target(root: &Path) -> Option<McpHttpTarget> {
    match read_config(root) {
        Ok(Some(target)) => Some(McpHttpTarget {
            url: target.url,
            workspace_id: target.workspace_id,
        }),
        _ => None,
    }
}

fn read_config(root: &Path) -> Result<Option<BackendTarget>, String> {
    let path = root.join(SYNC_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(&fs::read_to_string(&path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    if value.get("engine").and_then(|item| item.as_str()) != Some("backend") {
        return Err("当前 .tie/sync.json 不是后台同步。请用 --backend-url 和 --backend-workspace 重新配置".to_owned());
    }
    let url = value.get("url").and_then(|item| item.as_str()).unwrap_or("").trim().to_owned();
    let workspace_id = value
        .get("workspaceId")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    validate_target(&url, &workspace_id)?;
    Ok(Some(BackendTarget { url, workspace_id }))
}

fn write_config(root: &Path, url: &str, workspace_id: &str) -> Result<(), String> {
    let url = url.trim().trim_end_matches('/').to_owned();
    let workspace_id = workspace_id.trim().to_owned();
    validate_target(&url, &workspace_id)?;
    let tie = root.join(".tie");
    fs::create_dir_all(&tie).map_err(|error| error.to_string())?;
    let body = json!({
        "engine": "backend",
        "url": url,
        "workspaceId": workspace_id,
    });
    fs::write(tie.join("sync.json"), format!("{body}\n")).map_err(|error| error.to_string())?;
    Ok(())
}

fn validate_target(url: &str, workspace_id: &str) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://"))
        || url.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err("后台地址需要是 http 或 https URL".to_owned());
    }
    if workspace_id.is_empty() || workspace_id.chars().any(|ch| ch.is_whitespace()) {
        return Err("后台工作区 id 无效".to_owned());
    }
    Ok(())
}

pub fn read_sync_cursor(root: &Path) -> Result<serde_json::Value, String> {
    let cursor = read_cursor(root)?;
    serde_json::to_value(cursor).map_err(|error| error.to_string())
}

fn read_cursor(root: &Path) -> Result<HashMap<String, CursorEntry>, String> {
    let path = root.join(CURSOR_FILE);
    if !path.is_file() {
        return Ok(HashMap::new());
    }
    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn write_cursor(root: &Path, cursor: &HashMap<String, CursorEntry>) -> Result<(), String> {
    let tie = root.join(".tie");
    fs::create_dir_all(&tie).map_err(|error| error.to_string())?;
    let body = serde_json::to_string_pretty(cursor).map_err(|error| error.to_string())?;
    fs::write(tie.join("sync-cursor.json"), format!("{body}\n")).map_err(|error| error.to_string())?;
    Ok(())
}

/// Desktop and `tie sync` share this entry. An existing `.tie/sync.json` for the same
/// server is kept, so a folder stays on the workspace it already aligned with.
/// Otherwise the folder binds to the account workspace the caller picked.
pub fn align(ws: &LocalWorkspace, url: &str, workspace_id: &str) -> Result<BackendSyncReport, String> {
    let url = normalize_endpoint(url)?;
    if let Some(target) = read_config(ws.root())? {
        if normalize_endpoint(&target.url)? == url {
            return sync_workspace(ws);
        }
    }
    enable(ws, &url, workspace_id.trim())
}

/// Keep one side of a page both clients changed, then record a fresh cursor.
pub fn resolve_conflict(ws: &LocalWorkspace, page_id: &str, keep_local: bool) -> Result<BackendSyncReport, String> {
    let target = read_config(ws.root())?.ok_or("未配置后台。请先同步一次")?;
    let session = ensure_session(false)?;
    if normalize_endpoint(&session.endpoint)? != normalize_endpoint(&target.url)? {
        return Err("当前登录的后台和这个工作区配置的后台不是同一台".to_owned());
    }
    let client = http_client()?;
    let me = fetch_me(&client, &session)?;
    let owned = list_owned_workspaces(&client, &session)?;
    if !owned.iter().any(|id| id == &target.workspace_id) {
        return Err(format!(
            "工作区 {} 不属于当前用户 {}",
            target.workspace_id, me.email
        ));
    }
    let actor = if session.name.trim().is_empty() { me.email.clone() } else { session.name.clone() };
    let remote_pages = list_remote(&client, &target, &session.access_token)?;
    let local_pages = ws.load_all(true)?;
    let local = local_pages.iter().find(|page| page.id == page_id).cloned();
    let remote = remote_pages.into_iter().find(|page| page.id == page_id);
    if let (Some(local_page), Some(remote_page)) = (local.as_ref(), remote.as_ref()) {
        note_divergence(ws.root(), &actor, local_page, remote_page);
        let chosen = if keep_local { &local_page.updated_at } else { &remote_page.updated_at };
        let other = if keep_local { &remote_page.updated_at } else { &local_page.updated_at };
        mark_resolution(ws.root(), page_id, chosen, other);
        append_audit(ws.root(), &json!({
            "type": "resolve",
            "actor": actor,
            "pageId": page_id,
            "title": local_page.title,
            "status": "applied",
            "note": if keep_local { "最终版本留下本机这一边" } else { "最终版本留下后台那一边" }
        }));
    }
    let mut cursor = read_cursor(ws.root())?;
    let (pushed, pulled) = if keep_local {
        let local = local.ok_or("本地没有这一页")?;
        let saved = put_remote(&client, &target, &session.access_token, &local, None)?;
        cursor.insert(local.id.clone(), entry(&local, &saved));
        (1, 0)
    } else {
        let remote = remote.ok_or("后台没有这一页")?;
        pull_page(ws, &remote, local.as_ref())?;
        cursor.insert(remote.id.clone(), entry(&remote, &remote));
        (0, 1)
    };
    write_cursor(ws.root(), &cursor)?;
    let _ = exchange_reviews(&client, &target, &session.access_token, ws.root(), page_id);
    let report = BackendSyncReport {
        mode: "synced".into(),
        message: String::new(),
        peer: "backend".into(),
        url: target.url.clone(),
        workspace_id: target.workspace_id.clone(),
        pushed,
        pulled,
        conflicts: Vec::new(),
        user_email: me.email,
    };
    write_status(ws.root(), &report);
    Ok(report)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ReviewEntry {
    id: String,
    at: String,
    actor: String,
    kind: String,
    #[serde(default)]
    side: String,
    status: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    markdown: String,
    #[serde(default)]
    quote: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    opinion_kind: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
struct ReviewFile {
    entries: Vec<ReviewEntry>,
}

fn review_path(root: &Path, page_id: &str) -> Result<std::path::PathBuf, String> {
    if page_id.is_empty() || page_id.contains(['/', '\\']) || page_id.contains("..") {
        return Err("页面 id 无效".to_owned());
    }
    Ok(root.join(".tie").join("reviews").join(format!("{page_id}.json")))
}

fn read_reviews(root: &Path, page_id: &str) -> ReviewFile {
    let Ok(path) = review_path(root, page_id) else { return ReviewFile::default() };
    let Ok(raw) = fs::read_to_string(path) else { return ReviewFile::default() };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_reviews(root: &Path, page_id: &str, file: &ReviewFile) -> Result<(), String> {
    let path = review_path(root, page_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = serde_json::to_string_pretty(file).map_err(|error| error.to_string())?;
    fs::write(path, format!("{body}\n")).map_err(|error| error.to_string())
}

fn status_rank(status: &str) -> u8 {
    match status {
        "final" => 2,
        "kept" | "dropped" => 1,
        _ => 0,
    }
}

fn merge_reviews(mut current: ReviewFile, incoming: ReviewFile) -> ReviewFile {
    for entry in incoming.entries {
        if let Some(prev) = current.entries.iter_mut().find(|item| item.id == entry.id) {
            if status_rank(&entry.status) > status_rank(&prev.status) {
                let actor = if entry.actor != "另一端" && !entry.actor.is_empty() {
                    entry.actor.clone()
                } else if prev.actor != "另一端" && !prev.actor.is_empty() {
                    prev.actor.clone()
                } else {
                    entry.actor.clone()
                };
                *prev = entry;
                prev.actor = actor;
            } else if prev.actor == "另一端" && entry.actor != "另一端" && !entry.actor.is_empty() {
                prev.actor = entry.actor;
            }
        } else {
            current.entries.push(entry);
        }
    }
    current.entries.sort_by(|a, b| a.at.cmp(&b.at));
    current
}

fn version_id(page_id: &str, updated_at: &str) -> String {
    format!("rv_{page_id}_{updated_at}")
}

fn version_entry(page: &Page, actor: &str) -> ReviewEntry {
    ReviewEntry {
        id: version_id(&page.id, &page.updated_at),
        at: page.updated_at.clone(),
        actor: actor.to_owned(),
        kind: "version".into(),
        side: String::new(),
        status: "open".into(),
        title: page.title.clone(),
        markdown: page.markdown.clone(),
        quote: String::new(),
        body: String::new(),
        opinion_kind: String::new(),
    }
}

fn note_divergence(root: &Path, actor: &str, local: &Page, remote: &Page) {
    if local.updated_at == remote.updated_at && local.markdown == remote.markdown {
        return;
    }
    let mut file = read_reviews(root, &local.id);
    let before = file.entries.len();
    for (page, who) in [(local, actor), (remote, "另一端")] {
        let id = version_id(&page.id, &page.updated_at);
        if let Some(existing) = file.entries.iter_mut().find(|item| item.id == id) {
            if existing.actor == "另一端" && who != "另一端" {
                existing.actor = who.to_owned();
            }
        } else {
            file.entries.push(version_entry(page, who));
        }
    }
    if file.entries.len() != before {
        append_audit(root, &json!({
            "type": "diverge",
            "actor": actor,
            "pageId": local.id,
            "title": local.title,
            "status": "open",
            "note": "两边都改过。较新的一份已写入正文，另一份留在修改记录里"
        }));
    }
    let _ = write_reviews(root, &local.id, &file);
}

fn mark_resolution(root: &Path, page_id: &str, chosen_updated_at: &str, other_updated_at: &str) {
    let mut file = read_reviews(root, page_id);
    for entry in &mut file.entries {
        if entry.kind != "version" {
            continue;
        }
        if entry.id == version_id(page_id, chosen_updated_at) {
            entry.status = "final".into();
        } else if entry.id == version_id(page_id, other_updated_at) {
            entry.status = "dropped".into();
        }
    }
    let _ = write_reviews(root, page_id, &file);
}

pub fn read_review_file(root: &Path, page_id: &str) -> Value {
    serde_json::to_value(read_reviews(root, page_id)).unwrap_or_else(|_| json!({ "entries": [] }))
}

pub fn add_opinion(root: &Path, page_id: &str, id: &str, actor: &str, opinion_kind: &str, quote: &str, body: &str) -> Result<(), String> {
    if id.is_empty() || body.trim().is_empty() {
        return Err("修改意见不完整".to_owned());
    }
    let mut file = read_reviews(root, page_id);
    if file.entries.iter().any(|item| item.id == id) {
        return Ok(());
    }
    file.entries.push(ReviewEntry {
        id: id.to_owned(),
        at: local_stamp(),
        actor: actor.to_owned(),
        kind: "opinion".into(),
        side: String::new(),
        status: "open".into(),
        title: String::new(),
        markdown: String::new(),
        quote: quote.to_owned(),
        body: body.trim().to_owned(),
        opinion_kind: opinion_kind.to_owned(),
    });
    write_reviews(root, page_id, &file)?;
    append_audit(root, &json!({
        "type": "opinion",
        "actor": actor,
        "pageId": page_id,
        "title": quote,
        "status": "open",
        "note": body.trim()
    }));
    Ok(())
}

fn review_page_ids(root: &Path) -> Vec<String> {
    let dir = root.join(".tie").join("reviews");
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries.filter_map(|item| {
        let path = item.ok()?.path();
        let name = path.file_stem()?.to_str()?.to_owned();
        if path.extension().is_some_and(|ext| ext == "json") { Some(name) } else { None }
    }).collect()
}

fn exchange_reviews(client: &reqwest::blocking::Client, target: &BackendTarget, token: &str, root: &Path, page_id: &str) -> Result<(), String> {
    let local = read_reviews(root, page_id);
    let url = format!(
        "{}/api/v1/workspaces/{}/pages/{}/reviews",
        target.url.trim_end_matches('/'),
        target.workspace_id,
        page_id
    );
    let response = client.get(&url).bearer_auth(token).send().map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("读取修改记录失败：{}", response.status()));
    }
    let remote: ReviewFile = response.json().map_err(|error| error.to_string())?;
    let merged = merge_reviews(local.clone(), remote.clone());
    if merged != local {
        write_reviews(root, page_id, &merged)?;
    }
    if merged != remote {
        let put = client.put(url).bearer_auth(token).json(&merged).send().map_err(|error| error.to_string())?;
        if !put.status().is_success() {
            return Err(format!("写入修改记录失败：{}", put.status()));
        }
        let saved: ReviewFile = put.json().unwrap_or(merged);
        write_reviews(root, page_id, &saved)?;
    }
    Ok(())
}

fn append_audit(root: &Path, event: &Value) {
    let dir = root.join(".tie").join("audit");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut line = json!({ "at": local_stamp() });
    if let (Some(obj), Some(extra)) = (line.as_object_mut(), event.as_object()) {
        for (key, value) in extra {
            obj.insert(key.clone(), value.clone());
        }
    }
    let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(dir.join("events.jsonl")) else {
        return;
    };
    let _ = writeln!(file, "{line}");
}

fn iso_in(extra_secs: u64) -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .saturating_add(extra_secs);
    format_unix(secs)
}

fn local_stamp() -> String {
    iso_in(0)
}

fn format_unix(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let hour = tod / 3600;
    let minute = (tod % 3600) / 60;
    let second = tod % 60;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let mut year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

fn write_status(root: &Path, report: &BackendSyncReport) {
    let tie = root.join(".tie");
    if fs::create_dir_all(&tie).is_err() {
        return;
    }
    let body = json!({
        "state": report.mode,
        "message": report.message,
        "peer": report.peer,
        "url": report.url,
        "workspaceId": report.workspace_id,
        "pushed": report.pushed,
        "pulled": report.pulled,
        "conflicts": report.conflicts,
        "userEmail": report.user_email,
    });
    let _ = fs::write(tie.join(STATUS_FILE.trim_start_matches(".tie/")), format!("{body}\n"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(id: &str, markdown: &str, updated_at: &str) -> Page {
        Page {
            id: id.into(),
            title: "标题".into(),
            icon: String::new(),
            parent_id: None,
            sort_key: 0,
            markdown: markdown.into(),
            tags: Vec::new(),
            created_at: updated_at.into(),
            updated_at: updated_at.into(),
            deleted_at: None,
            storage_source_id: "src_local".into(),
            storage_source_ids: vec!["src_local".into()],
        }
    }

    #[test]
    fn plans_push_pull_and_conflict() {
        let local = page("pg_1", "本地", "2026-01-02T00:00:00.000Z");
        let remote = page("pg_1", "后台", "2026-01-02T00:00:00.000Z");
        let cursor = CursorEntry {
            local: "2026-01-01T00:00:00.000Z".into(),
            remote: "2026-01-01T00:00:00.000Z".into(),
        };
        assert_eq!(plan(Some(&local), None, None), Action::Push);
        assert_eq!(plan(None, Some(&remote), None), Action::Pull);
        assert_eq!(plan(Some(&local), Some(&remote), None), Action::Pull);
        let mut newer = local.clone();
        newer.updated_at = "2026-01-03T00:00:00.000Z".into();
        newer.markdown = "更新的本地".into();
        assert_eq!(plan(Some(&newer), Some(&remote), None), Action::Push);
        let mut remote_old = remote.clone();
        remote_old.updated_at = cursor.remote.clone();
        remote_old.markdown = "后台".into();
        assert_eq!(plan(Some(&local), Some(&remote_old), Some(&cursor)), Action::Push);
        let mut local_old = local.clone();
        local_old.updated_at = cursor.local.clone();
        local_old.markdown = "本地".into();
        assert_eq!(plan(Some(&local_old), Some(&remote), Some(&cursor)), Action::Pull);
        assert_eq!(plan(Some(&local), Some(&remote), Some(&cursor)), Action::Pull);
    }
}
