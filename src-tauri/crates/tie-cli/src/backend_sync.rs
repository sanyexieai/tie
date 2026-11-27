//! Align a local workspace with one Tie backend workspace.
//! Page bytes stay in tie-local. This module only decides push, pull, or conflict.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendSyncStage {
    Connecting,
    Pages,
    Assets,
    Files,
    Reviews,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct BackendSyncProgress {
    pub stage: BackendSyncStage,
    pub completed: usize,
    pub total: usize,
}

pub(crate) fn report_progress(
    observe: &mut dyn FnMut(BackendSyncProgress),
    stage: BackendSyncStage,
    completed: usize,
    total: usize,
) {
    observe(BackendSyncProgress { stage, completed, total });
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
    Conflict,
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
    sync_workspace_with_progress(ws, &mut |_| {})
}

fn sync_workspace_with_progress(
    ws: &LocalWorkspace,
    observe: &mut dyn FnMut(BackendSyncProgress),
) -> Result<BackendSyncReport, String> {
    report_progress(observe, BackendSyncStage::Connecting, 0, 3);
    let target = read_config(ws.root())?.ok_or("未配置后台。请指定 --backend-url 和 --backend-workspace")?;
    let session = ensure_session(false)?;
    report_progress(observe, BackendSyncStage::Connecting, 1, 3);
    let result = sync_as_user(&target, &session, ws, observe);
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
    observe: &mut dyn FnMut(BackendSyncProgress),
) -> Result<BackendSyncReport, String> {
    if !same_backend_endpoint(&session.endpoint, &target.url) {
        return Err("当前登录的后台和这个工作区配置的后台不是同一台".to_owned());
    }
    let client = http_client()?;
    let me = fetch_me(&client, session)?;
    report_progress(observe, BackendSyncStage::Connecting, 2, 3);
    let owned = list_owned_workspaces(&client, session)?;
    report_progress(observe, BackendSyncStage::Connecting, 3, 3);
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
    let mut report = sync_with_progress(target, &session.access_token, ws, &actor, observe)?;
    report.user_email = me.email;
    Ok(report)
}

#[cfg(test)]
fn sync_with(target: &BackendTarget, token: &str, ws: &LocalWorkspace, actor: &str) -> Result<BackendSyncReport, String> {
    sync_with_progress(target, token, ws, actor, &mut |_| {})
}

fn sync_with_progress(
    target: &BackendTarget,
    token: &str,
    ws: &LocalWorkspace,
    actor: &str,
    observe: &mut dyn FnMut(BackendSyncProgress),
) -> Result<BackendSyncReport, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;
    let remote_pages = list_remote(&client, target, token)?;
    let remote_review_ids = remote_pages.iter().map(|page| page.id.clone()).collect::<Vec<_>>();
    let local_pages = ws.load_all(true)?;
    let mut cursor = read_cursor(ws.root())?;
    let mut remote_by_id: HashMap<String, Page> = remote_pages
        .into_iter()
        .map(|page| (page.id.clone(), page))
        .collect();
    let mut pushed = 0u32;
    let mut pulled = 0u32;
    let mut conflicts = Vec::new();
    let mut protection_required = HashSet::new();
    let pages_total = local_pages.iter().map(|page| page.id.as_str())
        .chain(remote_by_id.keys().map(String::as_str)).collect::<HashSet<_>>().len();
    let mut pages_completed = HashSet::new();
    report_progress(observe, BackendSyncStage::Pages, 0, pages_total);

    for local in &local_pages {
        let remote = remote_by_id.remove(&local.id);
        if remote.as_ref().is_some_and(|remote| tie_local::is_encrypted_markdown(&remote.markdown) != tie_local::is_encrypted_markdown(&local.markdown)) {
            protection_required.insert(local.id.clone());
            conflicts.push(local.id.clone());
            if pages_completed.insert(local.id.clone()) {
                report_progress(observe, BackendSyncStage::Pages, pages_completed.len(), pages_total);
            }
            continue;
        }
        match plan(Some(local), remote.as_ref(), cursor.get(&local.id)) {
            Action::Skip => {
                if let Some(remote) = remote.as_ref() {
                    cursor.insert(local.id.clone(), entry(local, remote));
                }
            }
            Action::Push => {
                match put_remote(&client, target, token, local, remote.as_ref()) {
                Ok(saved) => {
                    cursor.insert(local.id.clone(), entry(local, &saved));
                    pushed += 1;
                }
                Err(error) if error == "conflict" => {
                    let fresh = get_remote_page(&client, target, token, &local.id)?;
                    note_divergence(ws.root(), actor, local, &fresh);
                    conflicts.push(local.id.clone());
                }
                Err(error) => return Err(error),
            }
            }
            Action::Pull => {
                if let Some(remote) = remote {
                    pull_page(ws, &remote, Some(local))?;
                    cursor.insert(remote.id.clone(), entry(&remote, &remote));
                    let _ = exchange_reviews(&client, target, token, ws.root(), &remote.id);
                    pulled += 1;
                }
            }
            Action::Conflict => {
                if let Some(remote) = remote {
                    note_divergence(ws.root(), actor, local, &remote);
                    conflicts.push(local.id.clone());
                }
            }
        }
        if pages_completed.insert(local.id.clone()) {
            report_progress(observe, BackendSyncStage::Pages, pages_completed.len(), pages_total);
        }
    }

    let mut purged = Vec::new();
    for remote in remote_by_id.into_values() {
        if remote.deleted_at.is_some()
            && cursor.get(&remote.id).is_some_and(|previous| previous.remote == remote.updated_at)
        {
            purged.push(remote.id.clone());
            continue;
        }
        match plan(None, Some(&remote), cursor.get(&remote.id)) {
            Action::Pull | Action::Skip => {
                pull_page(ws, &remote, None)?;
                cursor.insert(remote.id.clone(), entry(&remote, &remote));
                let _ = exchange_reviews(&client, target, token, ws.root(), &remote.id);
                pulled += 1;
            }
            Action::Push | Action::Conflict => {}
        }
        if pages_completed.insert(remote.id.clone()) {
            report_progress(observe, BackendSyncStage::Pages, pages_completed.len(), pages_total);
        }
    }

    if !purged.is_empty() {
        let response = client.post(format!(
            "{}/api/v1/workspaces/{}/pages", target.url.trim_end_matches('/'), target.workspace_id
        )).bearer_auth(token).header("x-tie-replication", "1")
            .header("x-tie-origin", tie_local::changes::origin_header(&tie_local::changes::current_origin())?).json(&json!({ "pageIds": purged })).send()
            .map_err(|error| format!("永久删除尚未同步：{error}"))?;
        if !response.status().is_success() {
            return Err(format!("永久删除尚未同步：{}", response.status()));
        }
        for id in &purged {
            cursor.remove(id);
            if pages_completed.insert(id.clone()) {
                report_progress(observe, BackendSyncStage::Pages, pages_completed.len(), pages_total);
            }
        }
        pushed += purged.len() as u32;
    }

    crate::resources_sync::sync_resources(
        &client,
        &format!("{}/api/v1/workspaces/{}", target.url.trim_end_matches('/'), target.workspace_id),
        token,
        ws,
        &protection_required,
        observe,
    )?;
    write_cursor(ws.root(), &cursor)?;
    let mut review_ids = review_page_ids(ws.root());
    review_ids.extend(remote_review_ids);
    review_ids.extend(local_pages.iter().map(|page| page.id.clone()));
    review_ids.sort(); review_ids.dedup();
    review_ids.retain(|id| !protection_required.contains(id));
    report_progress(observe, BackendSyncStage::Reviews, 0, review_ids.len());
    for (index, page_id) in review_ids.iter().enumerate() {
        exchange_reviews(&client, target, token, ws.root(), &page_id)?;
        report_progress(observe, BackendSyncStage::Reviews, index + 1, review_ids.len());
    }
    let mode = if conflicts.is_empty() { "synced" } else { "conflict" };
    let message = if !protection_required.is_empty() {
        let mut pages = protection_required.into_iter().collect::<Vec<_>>();
        pages.sort();
        format!("[PROTECTION_REQUIRED] 这些页面的本地与服务器保护模式不同，已保留两侧正文、历史、讨论和附件；请解锁并显式转换两侧后重试同步：{}", pages.join("、"))
    } else if conflicts.is_empty() {
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

pub fn same_backend_endpoint(left: &str, right: &str) -> bool {
    match (normalize_endpoint(left), normalize_endpoint(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
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
                _ => Action::Conflict,
            }
        }
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
    tie_local::changes::with_change_context(tie_local::changes::current_origin(), None, true, || save_page_to_root(ws.root(), page, expected))?;
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
    let mut request = client.put(url).bearer_auth(token).header("x-tie-replication", "1")
        .header("x-tie-origin", tie_local::changes::origin_header(&tie_local::changes::current_origin())?).json(local);
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
    align_with_progress(ws, url, workspace_id, |_| {})
}

pub fn align_with_progress(
    ws: &LocalWorkspace,
    url: &str,
    workspace_id: &str,
    mut observe: impl FnMut(BackendSyncProgress),
) -> Result<BackendSyncReport, String> {
    let url = normalize_endpoint(url)?;
    if let Some(target) = read_config(ws.root())? {
        if normalize_endpoint(&target.url)? == url {
            return sync_workspace_with_progress(ws, &mut observe);
        }
    }
    write_config(ws.root(), &url, workspace_id.trim())?;
    sync_workspace_with_progress(ws, &mut observe)
}

/// Keep one side of a page both clients changed, then record a fresh cursor.
pub fn resolve_conflict(ws: &LocalWorkspace, page_id: &str, keep_local: bool) -> Result<BackendSyncReport, String> {
    let target = read_config(ws.root())?.ok_or("未配置后台。请先同步一次")?;
    let session = ensure_session(false)?;
    if !same_backend_endpoint(&session.endpoint, &target.url) {
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

use tie_local::changes::{ReviewEntry, ReviewFile, merge_reviews};

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
    tie_local::changes::merge_review_file(root, page_id, file.clone()).map(|_| ())
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
        ..ReviewEntry::default()
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
            "note": "两边都改过，正文未覆盖，请选择保留哪一份"
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
    tie_local::changes::add_signal(root, page_id, id, actor, opinion_kind, quote, body, "", None, None, None).map(|_| ())
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

    #[test]
    fn backend_endpoint_must_match_the_login_server() {
        assert!(same_backend_endpoint(" https://backend.example/ ", "https://backend.example"));
        assert!(!same_backend_endpoint("https://backend.example", "https://other.example"));
        assert!(!same_backend_endpoint("https://backend.example", "http://backend.example"));
        assert!(!same_backend_endpoint("https://backend.example/base", "https://backend.example"));
        assert!(!same_backend_endpoint("invalid", "invalid"));
    }

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
    fn encrypted_markdown_pushes_and_pulls_without_changing_ciphertext() {
        let dir = std::env::temp_dir().join(format!("tie-sync-encrypted-{}", tie_local::new_page_id()));
        let local = LocalWorkspace::init(dir.join("local"), "src_test").unwrap();
        let remote = LocalWorkspace::init(dir.join("remote"), "src_test").unwrap();
        let first = format!("{}\n{{\"ciphertext\":\"opaque-first\"}}\n-----END TIE ENCRYPTED MARKDOWN-----\n", tie_local::ENCRYPTED_MARKDOWN_PREFIX);
        let second = first.replace("opaque-first", "opaque-second");
        let item = page("pg_encrypted", &first, "2026-01-01T00:00:00.000Z");
        save_page_to_root(local.root(), item, None).unwrap();
        let root = remote.root().to_owned();
        let server = crate::test_http::Server::start(move |request, body| {
            let request = request.replace("/api/v1/workspaces/ws_test", "");
            let parts: Vec<_> = request.split_whitespace().collect();
            let path: Vec<_> = parts[1].trim_start_matches('/').split('/').collect();
            let ws = LocalWorkspace::open(&root, Some("src_test")).unwrap();
            match path.as_slice() {
                ["pages"] => (200, serde_json::to_vec(&ws.load_all(true).unwrap()).unwrap()),
                ["pages", _id] if parts[0] == "PUT" => {
                    let saved = save_page_to_root(&root, serde_json::from_slice(body).unwrap(), None).unwrap();
                    (200, serde_json::to_vec(&saved).unwrap())
                }
                ["pages", _id, "reviews"] => (200, b"{\"entries\":[]}".to_vec()),
                _ => crate::resources_sync::tests::respond(&root, &request, body),
            }
        });
        let target = BackendTarget { url: server.url.clone(), workspace_id: "ws_test".into() };
        let pushed = sync_with(&target, "", &local, "test").unwrap();
        assert_eq!(pushed.mode, "synced");
        assert_eq!(pushed.pushed, 1);
        let mut changed = remote.get_by_id("pg_encrypted").unwrap().unwrap();
        assert_eq!(changed.markdown, first);
        assert_eq!(changed.title, "标题");
        changed.markdown = second.clone();
        changed.updated_at = "2026-01-02T00:00:00.000Z".into();
        save_page_to_root(remote.root(), changed, None).unwrap();
        let pulled = sync_with(&target, "", &local, "test").unwrap();
        assert_eq!(pulled.mode, "synced");
        assert_eq!(pulled.pulled, 1);
        assert_eq!(local.get_by_id("pg_encrypted").unwrap().unwrap().markdown, second);
        let revision = &local.list_revisions("pg_encrypted").unwrap()[0];
        assert_eq!(revision.title, "标题");
        assert_eq!(local.get_revision("pg_encrypted", &revision.id).unwrap().markdown, first);
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn protection_mode_mismatch_preserves_both_sides_and_skips_reviews_and_assets() {
        for local_encrypted in [false, true] {
            let dir = std::env::temp_dir().join(format!("tie-sync-protection-{}", tie_local::new_page_id()));
            let local = LocalWorkspace::init(dir.join("local"), "src_test").unwrap();
            let remote = LocalWorkspace::init(dir.join("remote"), "src_test").unwrap();
            let cipher = format!("{}\n{{\"ciphertext\":\"opaque-protected\"}}\n-----END TIE ENCRYPTED MARKDOWN-----\n", tie_local::ENCRYPTED_MARKDOWN_PREFIX);
            save_page_to_root(local.root(), page("pg_protection", if local_encrypted { &cipher } else { "local plaintext" }, "2026-01-01T00:00:00Z"), None).unwrap();
            save_page_to_root(remote.root(), page("pg_protection", if local_encrypted { "remote plaintext" } else { &cipher }, "2026-01-02T00:00:00Z"), None).unwrap();
            for workspace in [&local, &remote] {
                let assets = tie_local::page_asset_dir(workspace.root(), "pg_protection");
                fs::create_dir_all(&assets).unwrap();
                fs::write(assets.join("asset.png"), workspace.root().to_string_lossy().as_bytes()).unwrap();
            }
            let before_local = serde_json::to_value(local.protection_bundle("pg_protection").unwrap()).unwrap();
            let before_remote = serde_json::to_value(remote.protection_bundle("pg_protection").unwrap()).unwrap();
            let root = remote.root().to_owned();
            let server = crate::test_http::Server::start(move |request, body| {
                let request = request.replace("/api/v1/workspaces/ws_test", "");
                assert!(!request.contains("/pages/pg_protection"), "protected page operation must wait for explicit unlock: {request}");
                if request.starts_with("GET /pages ") {
                    let ws = LocalWorkspace::open(&root, Some("src_test")).unwrap();
                    (200, serde_json::to_vec(&ws.load_all(true).unwrap()).unwrap())
                } else { crate::resources_sync::tests::respond(&root, &request, body) }
            });
            let target = BackendTarget { url: server.url.clone(), workspace_id: "ws_test".into() };
            let report = sync_with(&target, "", &local, "test").unwrap();
            assert_eq!(report.mode, "conflict");
            assert!(report.message.contains("PROTECTION_REQUIRED"));
            assert_eq!(report.conflicts, ["pg_protection"]);
            assert_eq!(serde_json::to_value(local.protection_bundle("pg_protection").unwrap()).unwrap(), before_local);
            assert_eq!(serde_json::to_value(remote.protection_bundle("pg_protection").unwrap()).unwrap(), before_remote);
            drop(server);
            fs::remove_dir_all(dir).unwrap();
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
        assert_eq!(plan(Some(&local), Some(&remote), None), Action::Conflict);
        let mut newer = local.clone();
        newer.updated_at = "2026-01-03T00:00:00.000Z".into();
        newer.markdown = "更新的本地".into();
        assert_eq!(plan(Some(&newer), Some(&remote), None), Action::Conflict);
        let mut remote_old = remote.clone();
        remote_old.updated_at = cursor.remote.clone();
        remote_old.markdown = "后台".into();
        assert_eq!(plan(Some(&local), Some(&remote_old), Some(&cursor)), Action::Push);
        let mut local_old = local.clone();
        local_old.updated_at = cursor.local.clone();
        local_old.markdown = "本地".into();
        assert_eq!(plan(Some(&local_old), Some(&remote), Some(&cursor)), Action::Pull);
        assert_eq!(plan(Some(&local), Some(&remote), Some(&cursor)), Action::Conflict);
    }

    #[test]
    fn conflicts_and_concurrent_remote_edits_preserve_both_files() {
        use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
        for concurrent in [false, true] {
            let dir = std::env::temp_dir().join(format!("tie-conflict-{}-{concurrent}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            let local_ws = LocalWorkspace::init(&dir.join("local"), "src_test").unwrap();
            let remote_ws = LocalWorkspace::init(&dir.join("remote"), "src_test").unwrap();
            let local = page("pg_sync", "local draft", "2026-01-02T00:00:00.000Z");
            let remote = page("pg_sync", "remote draft", "2026-01-01T00:00:00.000Z");
            save_page_to_root(local_ws.root(), local.clone(), None).unwrap();
            save_page_to_root(remote_ws.root(), remote.clone(), None).unwrap();
            if concurrent {
                let cursor = HashMap::from([(local.id.clone(), CursorEntry {
                    local: "2025-12-31T00:00:00.000Z".into(), remote: remote.updated_at.clone(),
                })]);
                write_cursor(local_ws.root(), &cursor).unwrap();
            }
            let puts = Arc::new(AtomicUsize::new(0));
            let requests = puts.clone();
            let root = remote_ws.root().to_owned();
            let server = crate::test_http::Server::start(move |request, body| {
                let request = request.replace("/api/v1/workspaces/ws_test", "");
                if request.starts_with("GET /pages HTTP") {
                    let ws = LocalWorkspace::open(&root, Some("src_test")).unwrap();
                    return (200, serde_json::to_vec(&ws.load_all(true).unwrap()).unwrap());
                }
                if request.contains("/reviews ") {
                    return (200, if request.starts_with("PUT ") { body.to_vec() } else { b"{\"entries\":[]}".to_vec() });
                }
                if request.contains(" /pages/pg_sync HTTP") {
                    let ws = LocalWorkspace::open(&root, Some("src_test")).unwrap();
                    if request.starts_with("PUT ") {
                        requests.fetch_add(1, Ordering::SeqCst);
                        let changed = page("pg_sync", "concurrent remote", "2026-01-03T00:00:00.000Z");
                        save_page_to_root(&root, changed, None).unwrap();
                        return (409, b"{}".to_vec());
                    }
                    return (200, serde_json::to_vec(&ws.resolve("pg_sync").unwrap().unwrap()).unwrap());
                }
                crate::resources_sync::tests::respond(&root, &request, body)
            });
            let target = BackendTarget { url: server.url.clone(), workspace_id: "ws_test".into() };
            let report = sync_with(&target, "", &local_ws, "test").unwrap();
            assert_eq!(report.mode, "conflict");
            assert_eq!(report.conflicts, vec!["pg_sync"]);
            assert_eq!(report.pushed, 0);
            assert_eq!(report.pulled, 0);
            assert_eq!(local_ws.resolve("pg_sync").unwrap().unwrap().markdown, "local draft");
            assert_eq!(remote_ws.resolve("pg_sync").unwrap().unwrap().markdown,
                if concurrent { "concurrent remote" } else { "remote draft" });
            assert_eq!(puts.load(Ordering::SeqCst), usize::from(concurrent));
            assert_eq!(read_reviews(local_ws.root(), "pg_sync").entries.iter().filter(|entry| entry.kind == "version").count(), 2);
            drop(server);
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn purges_only_tracked_unchanged_remote_trash() {
        use std::sync::{Arc, Mutex};
        let dir = std::env::temp_dir().join(format!("tie-sync-purge-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let local = LocalWorkspace::init(&dir.join("local"), "src_test").unwrap();
        let remote = LocalWorkspace::init(&dir.join("remote"), "src_test").unwrap();
        let stamp = "2026-01-02T00:00:00.000Z";
        let mut cursor = HashMap::new();
        for (id, deleted, tracked) in [
            ("pg_purged", true, true), ("pg_unseen", true, false),
            ("pg_active", false, true), ("pg_changed", true, true),
        ] {
            let mut item = page(id, id, stamp);
            if deleted { item.deleted_at = Some(stamp.into()); }
            save_page_to_root(remote.root(), item, None).unwrap();
            if tracked {
                cursor.insert(id.into(), CursorEntry {
                    local: stamp.into(),
                    remote: if id == "pg_changed" { "2026-01-01T00:00:00.000Z" } else { stamp }.into(),
                });
            }
        }
        write_cursor(local.root(), &cursor).unwrap();
        let deleted = Arc::new(Mutex::new(Vec::<String>::new()));
        let recorded = deleted.clone();
        let root = remote.root().to_owned();
        let server = crate::test_http::Server::start(move |request, body| {
            let request = request.replace("/api/v1/workspaces/ws_test", "");
            let ws = LocalWorkspace::open(&root, Some("src_test")).unwrap();
            if request.starts_with("GET /pages HTTP") {
                return (200, serde_json::to_vec(&ws.load_all(true).unwrap()).unwrap());
            }
            if request.starts_with("POST /pages HTTP") {
                let value: Value = serde_json::from_slice(body).unwrap();
                for id in value["pageIds"].as_array().unwrap() {
                    let id = id.as_str().unwrap();
                    ws.purge_page(id, false).unwrap();
                    recorded.lock().unwrap().push(id.to_owned());
                }
                return (204, Vec::new());
            }
            if request.contains("/reviews ") { return (200, b"{\"entries\":[]}".to_vec()); }
            crate::resources_sync::tests::respond(&root, &request, body)
        });
        let target = BackendTarget { url: server.url.clone(), workspace_id: "ws_test".into() };
        let first = sync_with(&target, "", &local, "test").unwrap();
        assert_eq!(first.pushed, 1);
        assert_eq!(first.pulled, 3);
        assert_eq!(*deleted.lock().unwrap(), vec!["pg_purged"]);
        assert!(local.resolve("pg_purged").unwrap().is_none());
        assert!(remote.resolve("pg_purged").unwrap().is_none());
        assert!(!read_cursor(local.root()).unwrap().contains_key("pg_purged"));
        for id in ["pg_unseen", "pg_active", "pg_changed"] {
            assert!(local.resolve(id).unwrap().is_some());
            assert!(remote.resolve(id).unwrap().is_some());
        }
        let next = sync_with(&target, "", &local, "test").unwrap();
        assert_eq!(next.pushed, 0);
        assert_eq!(next.pulled, 0);
        assert!(local.resolve("pg_purged").unwrap().is_none());
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn alignment_reports_actual_stage_totals_and_completion() {
        let dir = std::env::temp_dir().join(format!("tie-sync-progress-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let local = LocalWorkspace::init(&dir.join("local"), "src_test").unwrap();
        let remote = LocalWorkspace::init(&dir.join("remote"), "src_test").unwrap();
        let stamp = "2026-01-02T00:00:00.000Z";
        for id in ["pg_local", "pg_shared"] {
            save_page_to_root(local.root(), page(id, id, stamp), None).unwrap();
        }
        for id in ["pg_remote", "pg_shared"] {
            save_page_to_root(remote.root(), page(id, id, stamp), None).unwrap();
        }
        for id in ["file_local", "file_shared", "file_remote"] {
            let meta = json!({ "id": id, "title": id, "kind": "file", "mode": "link",
                "sourcePath": "/fixture/reference.txt", "updatedAt": stamp });
            if id != "file_remote" { local.files().upsert_metadata(&meta).unwrap(); }
            if id != "file_local" { remote.files().upsert_metadata(&meta).unwrap(); }
        }
        add_opinion(local.root(), "pg_local", "op_local", "test", "note", "", "local record").unwrap();
        add_opinion(remote.root(), "pg_remote", "op_remote", "test", "note", "", "remote record").unwrap();
        let root = remote.root().to_owned();
        let server = crate::test_http::Server::start(move |request, body| {
            if request.starts_with("GET /api/v1/me ") {
                return (200, br#"{"email":"test@example.com"}"#.to_vec());
            }
            if request.starts_with("GET /api/v1/workspaces ") {
                return (200, br#"[{"id":"ws_test"}]"#.to_vec());
            }
            let request = request.replace("/api/v1/workspaces/ws_test", "");
            let parts: Vec<_> = request.split_whitespace().collect();
            let path: Vec<_> = parts[1].trim_start_matches('/').split('/').collect();
            let ws = LocalWorkspace::open(&root, Some("src_test")).unwrap();
            match path.as_slice() {
                ["pages"] => (200, serde_json::to_vec(&ws.load_all(true).unwrap()).unwrap()),
                ["pages", _id] if parts[0] == "PUT" => {
                    let saved = save_page_to_root(&root, serde_json::from_slice(body).unwrap(), None).unwrap();
                    (200, serde_json::to_vec(&saved).unwrap())
                }
                ["pages", id, "reviews"] => {
                    if parts[0] == "PUT" {
                        write_reviews(&root, id, &serde_json::from_slice(body).unwrap()).unwrap();
                    }
                    (200, serde_json::to_vec(&read_review_file(&root, id)).unwrap())
                }
                _ => crate::resources_sync::tests::respond(&root, &request, body),
            }
        });
        let session_dir = dir.join("session");
        tie_local::backend_session::write_session_at(&session_dir, &tie_local::backend_session::BackendSession {
            endpoint: server.url.clone(), access_token: String::new(), refresh_token: String::new(),
            access_expires_at: String::new(), user_id: "test-user".into(),
            email: "test@example.com".into(), name: "test".into(),
        }).unwrap();
        let previous = std::env::var_os("TIE_APP_DATA");
        std::env::set_var("TIE_APP_DATA", &session_dir);
        let mut progress = Vec::new();
        let result = align_with_progress(&local, &server.url, "ws_test", |step| progress.push(step));
        if let Some(previous) = previous {
            std::env::set_var("TIE_APP_DATA", previous);
        } else {
            std::env::remove_var("TIE_APP_DATA");
        }
        let report = result.unwrap();
        assert_eq!((report.pushed, report.pulled), (1, 1));
        let expected = [
            (BackendSyncStage::Connecting, 3), (BackendSyncStage::Pages, 3),
            (BackendSyncStage::Assets, 3), (BackendSyncStage::Files, 3),
            (BackendSyncStage::Reviews, 3),
        ];
        let mut stages: Vec<_> = progress.iter().map(|step| step.stage).collect();
        stages.dedup();
        assert_eq!(stages, expected.map(|(stage, _)| stage));
        for (stage, total) in expected {
            let actual: Vec<_> = progress.iter().copied().filter(|step| step.stage == stage).collect();
            let expected: Vec<_> = (0..=total).map(|completed| BackendSyncProgress { stage, completed, total }).collect();
            assert_eq!(actual, expected);
        }
        assert_eq!(serde_json::to_value(progress[0]).unwrap(), json!({ "stage": "connecting", "completed": 0, "total": 3 }));
        assert_eq!(local.load_all(true).unwrap().len(), 3);
        assert_eq!(local.files().all_metadata().len(), 3);
        assert_eq!(remote.files().all_metadata().len(), 3);
        drop(server);
        fs::remove_dir_all(dir).unwrap();
    }
}
