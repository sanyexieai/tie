use crate::common::{app_data_dir, workspace_sources};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::AppHandle;

const SYNC_FILE: &str = ".tie/sync.json";

/// Pinned MinGit for Windows on-demand download (not bundled in the installer).
#[cfg(windows)]
const MINGIT_VERSION: &str = "2.47.1";
#[cfg(windows)]
const MINGIT_URL: &str =
    "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/MinGit-2.47.1-64-bit.zip";
#[cfg(windows)]
const MINGIT_MANUAL_URL: &str =
    "https://github.com/git-for-windows/git/releases/tag/v2.47.1.windows.2";

#[cfg(not(windows))]
const GIT_INSTALL_HINT: &str = "请先安装 Git（macOS: brew install git；Linux: 使用发行版包管理器），或设置环境变量 TIE_GIT 指向 git 可执行文件。";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncResult {
    pub mode: String,
    pub message: String,
    pub committed: bool,
    pub pushed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRuntimeStatus {
    pub available: bool,
    pub path: Option<String>,
    pub source: String,
    pub version: Option<String>,
    pub download_url: Option<String>,
    pub can_download: bool,
    pub message: String,
}

#[derive(Clone, Debug)]
struct SyncConfig {
    remote: String,
    url: String,
}

pub(crate) fn validate_remote_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty()
        || url.len() > 2000
        || url.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err("Git remote 无效".to_owned());
    }
    let allowed = url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("ssh://")
        || url.starts_with("git@")
        || url.starts_with("file://");
    if !allowed {
        return Err("Git remote 需要是 https、ssh、git@ 或 file URL".to_owned());
    }
    Ok(())
}

fn source_dir(app: &AppHandle, source_id: &str) -> Result<PathBuf, String> {
    let (sources, _) = workspace_sources(app)?;
    let source = sources
        .iter()
        .find(|item| item.id == source_id)
        .ok_or("存储源不存在")?;
    if source.kind != "local" && source.kind != "smb" {
        return Err("多设备同步作用在本地/SMB 工作区目录上。后台存储由服务端落盘；请把同步 remote 配在本地副本上。".to_owned());
    }
    let path = PathBuf::from(&source.path);
    if !path.is_dir() {
        return Err("工作区目录不存在".to_owned());
    }
    Ok(path)
}

fn runtime_git_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("runtime").join("git"))
}

fn bundled_runtime_git(app: &AppHandle) -> Option<PathBuf> {
    let root = runtime_git_dir(app).ok()?;
    #[cfg(windows)]
    {
        let candidates = [
            root.join("cmd").join("git.exe"),
            root.join("mingw64").join("bin").join("git.exe"),
            root.join("bin").join("git.exe"),
        ];
        candidates.into_iter().find(|path| path.is_file())
    }
    #[cfg(not(windows))]
    {
        let path = root.join("bin").join("git");
        path.is_file().then_some(path)
    }
}

fn probe_git(path: &Path) -> Option<String> {
    let output = Command::new(path)
        .arg("--version")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let version = text.lines().next().unwrap_or("").trim();
    if version.is_empty() {
        None
    } else {
        Some(version.to_owned())
    }
}

fn resolve_git(app: &AppHandle) -> Option<(PathBuf, &'static str, String)> {
    if let Ok(override_path) = std::env::var("TIE_GIT") {
        let path = PathBuf::from(override_path.trim());
        if let Some(version) = probe_git(&path) {
            return Some((path, "env", version));
        }
    }
    if let Some(path) = bundled_runtime_git(app) {
        if let Some(version) = probe_git(&path) {
            return Some((path, "downloaded", version));
        }
    }
    let fallback = if cfg!(windows) { "git.exe" } else { "git" };
    if let Some(version) = probe_git(Path::new(fallback)) {
        return Some((PathBuf::from(fallback), "system", version));
    }
    None
}

fn runtime_status(app: &AppHandle) -> GitRuntimeStatus {
    if let Some((path, source, version)) = resolve_git(app) {
        return GitRuntimeStatus {
            available: true,
            path: Some(path.display().to_string()),
            source: source.to_owned(),
            version: Some(version),
            download_url: download_url(),
            can_download: cfg!(windows),
            message: String::new(),
        };
    }
    GitRuntimeStatus {
        available: false,
        path: None,
        source: "missing".into(),
        version: None,
        download_url: download_url(),
        can_download: cfg!(windows),
        message: missing_git_message(),
    }
}

fn download_url() -> Option<String> {
    #[cfg(windows)]
    {
        Some(MINGIT_URL.to_owned())
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn missing_git_message() -> String {
    #[cfg(windows)]
    {
        format!(
            "未找到 Git。可一键下载 MinGit {MINGIT_VERSION} 到应用数据目录，或手动安装：{MINGIT_MANUAL_URL}"
        )
    }
    #[cfg(not(windows))]
    {
        GIT_INSTALL_HINT.to_owned()
    }
}

fn require_git(app: &AppHandle) -> Result<PathBuf, String> {
    resolve_git(app)
        .map(|(path, _, _)| path)
        .ok_or_else(missing_git_message)
}

fn read_config(root: &Path) -> Result<Option<SyncConfig>, String> {
    let path = root.join(SYNC_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if value.get("engine").and_then(|item| item.as_str()) != Some("git") {
        return Ok(None);
    }
    let url = value.get("url").and_then(|item| item.as_str()).unwrap_or("").trim().to_owned();
    if !url.is_empty() {
        validate_remote_url(&url)?;
    }
    let remote = value
        .get("remote")
        .and_then(|item| item.as_str())
        .unwrap_or("origin")
        .trim()
        .to_owned();
    if remote.is_empty() || remote.chars().any(|ch| ch.is_whitespace()) {
        return Err("Git remote 名称无效".to_owned());
    }
    Ok(Some(SyncConfig { remote, url }))
}

fn write_config(root: &Path, url: &str) -> Result<(), String> {
    let tie = root.join(".tie");
    fs::create_dir_all(&tie).map_err(|error| error.to_string())?;
    let ignore = tie.join(".gitignore");
    if !ignore.exists() {
        fs::write(&ignore, "sync.json\n").map_err(|error| error.to_string())?;
    }
    let body = serde_json::json!({
        "engine": "git",
        "remote": "origin",
        "url": url,
    });
    fs::write(tie.join("sync.json"), format!("{body}\n")).map_err(|error| error.to_string())?;
    Ok(())
}

fn run_git(git: &Path, root: &Path, args: &[String]) -> Result<std::process::Output, String> {
    Command::new(git)
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .output()
        .map_err(|error| format!("无法运行 git：{error}"))
}

fn git_text(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if stderr.is_empty() {
        stdout
    } else {
        stderr
    }
}

fn git_ok(output: std::process::Output) -> Result<String, String> {
    if output.status.success() {
        return Ok(git_text(&output));
    }
    Err(git_text(&output))
}

fn ensure_repo(git: &Path, root: &Path) -> Result<(), String> {
    if root.join(".git").exists() {
        return Ok(());
    }
    git_ok(run_git(git, root, &["init".into(), "-b".into(), "main".into()])?)?;
    Ok(())
}

fn ensure_remote(git: &Path, root: &Path, remote: &str, url: &str) -> Result<(), String> {
    if url.is_empty() {
        return Ok(());
    }
    let current = run_git(git, root, &["remote".into(), "get-url".into(), remote.into()])?;
    if current.status.success() {
        let existing = String::from_utf8_lossy(&current.stdout).trim().to_owned();
        if existing != url {
            git_ok(run_git(
                git,
                root,
                &["remote".into(), "set-url".into(), remote.into(), url.into()],
            )?)?;
        }
        return Ok(());
    }
    git_ok(run_git(
        git,
        root,
        &["remote".into(), "add".into(), remote.into(), url.into()],
    )?)?;
    Ok(())
}

fn commit_tree(git: &Path, root: &Path) -> Result<bool, String> {
    for path in ["pages", ".tie"] {
        if root.join(path).exists() {
            git_ok(run_git(git, root, &["add".into(), "--".into(), path.into()])?)?;
        }
    }
    let diff = run_git(git, root, &["diff".into(), "--cached".into(), "--quiet".into()])?;
    if diff.status.code() == Some(0) {
        return Ok(false);
    }
    if diff.status.code() != Some(1) {
        return Err(git_text(&diff));
    }
    git_ok(run_git(
        git,
        root,
        &[
            "-c".into(),
            "user.name=Tie".into(),
            "-c".into(),
            "user.email=tie@localhost".into(),
            "commit".into(),
            "-m".into(),
            "tie: sync workspace".into(),
        ],
    )?)?;
    Ok(true)
}

fn current_branch(git: &Path, root: &Path) -> Result<String, String> {
    let name = git_ok(run_git(
        git,
        root,
        &["rev-parse".into(), "--abbrev-ref".into(), "HEAD".into()],
    )?)?;
    if name.is_empty() || name == "HEAD" {
        Ok("main".to_owned())
    } else {
        Ok(name)
    }
}

fn sync_remote(git: &Path, root: &Path, remote: &str) -> Result<(), String> {
    let listed = git_ok(run_git(git, root, &["remote".into()])?)?;
    if !listed.split_whitespace().any(|name| name == remote) {
        return Ok(());
    }
    git_ok(run_git(git, root, &["fetch".into(), remote.into()])?)?;
    let branch = current_branch(git, root)?;
    let remote_ref = format!("{remote}/{branch}");
    let exists = run_git(
        git,
        root,
        &[
            "rev-parse".into(),
            "--verify".into(),
            "--quiet".into(),
            remote_ref,
        ],
    )?;
    if !exists.status.success() {
        git_ok(run_git(
            git,
            root,
            &["push".into(), "-u".into(), remote.into(), "HEAD".into()],
        )?)?;
        return Ok(());
    }
    let pull = run_git(
        git,
        root,
        &[
            "pull".into(),
            "--rebase".into(),
            "--autostash".into(),
            remote.into(),
            branch.clone(),
        ],
    )?;
    if !pull.status.success() {
        let _ = run_git(git, root, &["rebase".into(), "--abort".into()]);
        return Err(format!(
            "与其他设备内容冲突，已保留本地版本。{}",
            git_text(&pull)
        ));
    }
    git_ok(run_git(
        git,
        root,
        &["push".into(), remote.into(), "HEAD".into()],
    )?)?;
    Ok(())
}

fn sync_root(git: &Path, root: &Path, config: Option<&SyncConfig>) -> Result<GitSyncResult, String> {
    let has_repo = root.join(".git").exists();
    if !has_repo && config.is_none() {
        return Ok(GitSyncResult {
            mode: "skipped".into(),
            message: "".into(),
            committed: false,
            pushed: false,
        });
    }
    ensure_repo(git, root)?;
    if let Some(config) = config {
        ensure_remote(git, root, &config.remote, &config.url)?;
    }
    let committed = commit_tree(git, root)?;
    let remote_name = config.map(|item| item.remote.as_str()).unwrap_or("origin");
    let listed = git_ok(run_git(git, root, &["remote".into()])?).unwrap_or_default();
    let has_remote = listed.split_whitespace().any(|name| name == remote_name);
    if !has_remote {
        return Ok(GitSyncResult {
            mode: "committed".into(),
            message: "已保存本地变更，尚未配置多设备同步地址".into(),
            committed,
            pushed: false,
        });
    }
    sync_remote(git, root, remote_name)?;
    Ok(GitSyncResult {
        mode: "synced".into(),
        message: "".into(),
        committed,
        pushed: true,
    })
}

#[cfg(windows)]
fn download_mingit(app: &AppHandle) -> Result<PathBuf, String> {
    let runtime = runtime_git_dir(app)?;
    if let Some(existing) = bundled_runtime_git(app) {
        return Ok(existing);
    }
    fs::create_dir_all(&runtime).map_err(|error| error.to_string())?;
    let staging = app_data_dir(app)?.join("runtime").join("git-download");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let zip_path = staging.join(format!("MinGit-{MINGIT_VERSION}.zip"));

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(MINGIT_URL)
        .send()
        .map_err(|error| format!("下载 Git 失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载 Git 失败：HTTP {}", response.status()));
    }
    let buffer = response
        .bytes()
        .map_err(|error| format!("下载 Git 失败：{error}"))?;
    fs::write(&zip_path, &buffer).map_err(|error| error.to_string())?;

    let extract_to = staging.join("extract");
    fs::create_dir_all(&extract_to).map_err(|error| error.to_string())?;
    let zip_arg = zip_path.to_string_lossy().replace('\'', "''");
    let dest_arg = extract_to.to_string_lossy().replace('\'', "''");
    let status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("Expand-Archive -LiteralPath '{zip_arg}' -DestinationPath '{dest_arg}' -Force"),
        ])
        .status()
        .map_err(|error| format!("解压 Git 失败：{error}"))?;
    if !status.success() {
        return Err("解压 Git 失败".to_owned());
    }

    let unpacked = find_mingit_root(&extract_to).ok_or("解压后未找到 git.exe")?;
    // Replace runtime dir contents with MinGit tree.
    let _ = fs::remove_dir_all(&runtime);
    copy_dir_recursive(&unpacked, &runtime)?;
    let _ = fs::remove_dir_all(&staging);

    bundled_runtime_git(app).ok_or_else(|| "Git 已下载但无法运行".to_owned())
}

#[cfg(windows)]
fn find_mingit_root(root: &Path) -> Option<PathBuf> {
    let direct = [
        root.join("cmd").join("git.exe"),
        root.join("mingw64").join("bin").join("git.exe"),
    ];
    if direct.iter().any(|path| path.is_file()) {
        return Some(root.to_path_buf());
    }
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if find_mingit_root(&path).is_some() {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(windows)]
fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(from).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_dir_recursive(&source, &target)?;
        } else {
            fs::copy(&source, &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn list_page_audit_events(
    app: AppHandle,
    source_id: String,
    page_id: String,
    limit: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    let root = source_dir(&app, &source_id)?;
    let path = root.join(".tie").join("audit").join("events.jsonl");
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let cap = limit.unwrap_or(40).max(1);
    let mut events = Vec::new();
    for line in raw.lines().rev() {
        if events.len() >= cap {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if value.get("pageId").and_then(|item| item.as_str()) != Some(page_id.as_str()) {
            continue;
        }
        events.push(value);
    }
    Ok(events)
}

#[tauri::command]
pub(crate) fn git_runtime_status(app: AppHandle) -> Result<GitRuntimeStatus, String> {
    Ok(runtime_status(&app))
}

#[tauri::command]
pub(crate) fn git_ensure_runtime(app: AppHandle) -> Result<GitRuntimeStatus, String> {
    if resolve_git(&app).is_some() {
        return Ok(runtime_status(&app));
    }
    #[cfg(windows)]
    {
        download_mingit(&app)?;
        return Ok(runtime_status(&app));
    }
    #[cfg(not(windows))]
    {
        Err(missing_git_message())
    }
}

#[tauri::command]
pub(crate) fn git_sync_workspace(app: AppHandle, source_id: String) -> Result<GitSyncResult, String> {
    let git = require_git(&app)?;
    let root = source_dir(&app, &source_id)?;
    let config = read_config(&root)?;
    sync_root(&git, &root, config.as_ref())
}

#[tauri::command]
pub(crate) fn git_enable_sync(
    app: AppHandle,
    source_id: String,
    remote_url: String,
) -> Result<GitSyncResult, String> {
    let url = remote_url.trim().to_owned();
    validate_remote_url(&url)?;
    let git = require_git(&app)?;
    let root = source_dir(&app, &source_id)?;
    write_config(&root, &url)?;
    let config = read_config(&root)?;
    sync_root(&git, &root, config.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_common_remote_urls() {
        assert!(validate_remote_url("https://example.com/tie.git").is_ok());
        assert!(validate_remote_url("git@github.com:tie/notes.git").is_ok());
        assert!(validate_remote_url("file:///tmp/tie.git").is_ok());
        assert!(validate_remote_url("notes.git").is_err());
        assert!(validate_remote_url("https://example.com/tie git").is_err());
    }
}
