//! Git alignment for a workspace tree. Page reads and writes stay in the workspace API.
//! Desktop and `tie sync` both call this so they share one lock and one commit sequence.

use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

const SYNC_FILE: &str = ".tie/sync.json";
const STATUS_FILE: &str = ".tie/sync-status.json";
const LOCK_FILE: &str = ".tie/sync.lock";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub mode: String,
    pub message: String,
    pub committed: bool,
    pub pushed: bool,
}

#[derive(Clone, Debug)]
struct SyncConfig {
    remote: String,
    url: String,
}

struct SyncLock {
    path: PathBuf,
    owned: bool,
}

impl Drop for SyncLock {
    fn drop(&mut self) {
        if !self.owned {
            return;
        }
        if read_lock_pid(&self.path) == Some(std::process::id()) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub fn validate_remote_url(url: &str) -> Result<(), String> {
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

pub fn resolve_git() -> Result<PathBuf, String> {
    if let Ok(override_path) = std::env::var("TIE_GIT") {
        let path = PathBuf::from(override_path.trim());
        if probe_git(&path).is_some() {
            return Ok(path);
        }
    }
    if let Some(path) = downloaded_runtime_git() {
        if probe_git(&path).is_some() {
            return Ok(path);
        }
    }
    let fallback = if cfg!(windows) { "git.exe" } else { "git" };
    if probe_git(Path::new(fallback)).is_some() {
        return Ok(PathBuf::from(fallback));
    }
    Err(missing_git_message())
}

pub fn read_sync_status(root: &Path) -> Result<Option<serde_json::Value>, String> {
    let path = root.join(STATUS_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    Ok(Some(value))
}

pub fn enable_and_sync(git: &Path, root: &Path, url: &str) -> Result<SyncReport, String> {
    let url = url.trim();
    validate_remote_url(url)?;
    write_sync_config(root, url)?;
    sync_workspace(git, root)
}

pub fn sync_workspace(git: &Path, root: &Path) -> Result<SyncReport, String> {
    let _lock = match try_acquire_lock(root)? {
        Some(lock) => lock,
        None => {
            return Ok(SyncReport {
                mode: "busy".into(),
                message: String::new(),
                committed: false,
                pushed: false,
            });
        }
    };
    let result = sync_workspace_locked(git, root);
    match &result {
        Ok(report) => write_status(root, report),
        Err(message) => write_status(
            root,
            &SyncReport {
                mode: "error".into(),
                message: message.clone(),
                committed: false,
                pushed: false,
            },
        ),
    }
    result
}

fn sync_workspace_locked(git: &Path, root: &Path) -> Result<SyncReport, String> {
    let tie = root.join(".tie");
    fs::create_dir_all(&tie).map_err(|error| error.to_string())?;
    ensure_sync_gitignore(&tie)?;
    let config = read_config(root)?;
    let has_repo = root.join(".git").exists();
    if !has_repo && config.is_none() {
        return Ok(SyncReport {
            mode: "skipped".into(),
            message: String::new(),
            committed: false,
            pushed: false,
        });
    }
    ensure_repo(git, root)?;
    if let Some(config) = &config {
        ensure_remote(git, root, &config.remote, &config.url)?;
    }
    let committed = commit_tree(git, root)?;
    let remote_name = config
        .as_ref()
        .map(|item| item.remote.as_str())
        .unwrap_or("origin");
    let listed = git_ok(run_git(git, root, &["remote"])?).unwrap_or_default();
    let has_remote = listed.split_whitespace().any(|name| name == remote_name);
    if !has_remote {
        return Ok(SyncReport {
            mode: "committed".into(),
            message: "已保存本地变更，尚未配置多设备同步地址".into(),
            committed,
            pushed: false,
        });
    }
    sync_remote(git, root, remote_name)?;
    Ok(SyncReport {
        mode: "synced".into(),
        message: String::new(),
        committed,
        pushed: true,
    })
}

fn downloaded_runtime_git() -> Option<PathBuf> {
    let root = app_runtime_git_dir()?;
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

fn app_runtime_git_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let appdata = std::env::var("APPDATA").ok()?;
        Some(
            PathBuf::from(appdata)
                .join("com.tie.knowledge")
                .join("runtime")
                .join("git"),
        )
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("com.tie.knowledge")
                .join("runtime")
                .join("git"),
        )
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .map(|home| PathBuf::from(home).join(".local").join("share"))
            })?;
        Some(base.join("com.tie.knowledge").join("runtime").join("git"))
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

fn missing_git_message() -> String {
    #[cfg(windows)]
    {
        "未找到 Git。可在桌面端下载同步组件，或设置 TIE_GIT 指向 git.exe。".to_owned()
    }
    #[cfg(not(windows))]
    {
        "未找到 Git。请先安装 Git，或设置 TIE_GIT 指向 git 可执行文件。".to_owned()
    }
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
    let url = value
        .get("url")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
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

fn write_sync_config(root: &Path, url: &str) -> Result<(), String> {
    let tie = root.join(".tie");
    fs::create_dir_all(&tie).map_err(|error| error.to_string())?;
    ensure_sync_gitignore(&tie)?;
    let body = serde_json::json!({
        "engine": "git",
        "remote": "origin",
        "url": url,
    });
    fs::write(tie.join("sync.json"), format!("{body}\n")).map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_sync_gitignore(tie: &Path) -> Result<(), String> {
    let ignore = tie.join(".gitignore");
    let mut text = if ignore.is_file() {
        fs::read_to_string(&ignore).map_err(|error| error.to_string())?
    } else {
        String::new()
    };
    let mut changed = false;
    for line in ["sync.json", "sync-status.json", "sync-cursor.json", "sync.lock", "page-locks/"] {
        if !text.lines().any(|existing| existing.trim() == line) {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(line);
            text.push('\n');
            changed = true;
        }
    }
    if changed || !ignore.is_file() {
        fs::write(&ignore, text).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn write_status(root: &Path, report: &SyncReport) {
    let tie = root.join(".tie");
    if fs::create_dir_all(&tie).is_err() {
        return;
    }
    let _ = ensure_sync_gitignore(&tie);
    let body = serde_json::json!({
        "state": report.mode,
        "message": report.message,
        "committed": report.committed,
        "pushed": report.pushed,
        "at": now_iso(),
    });
    let _ = fs::write(tie.join("sync-status.json"), format!("{body}\n"));
}

fn try_acquire_lock(root: &Path) -> Result<Option<SyncLock>, String> {
    let tie = root.join(".tie");
    fs::create_dir_all(&tie).map_err(|error| error.to_string())?;
    let path = root.join(LOCK_FILE);
    if path.is_file() {
        match read_lock_pid(&path) {
            Some(pid) if pid_alive(pid) && pid != std::process::id() => return Ok(None),
            _ => {
                let _ = fs::remove_file(&path);
            }
        }
    }
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            writeln!(file, "{}", std::process::id()).map_err(|error| error.to_string())?;
            Ok(Some(SyncLock { path, owned: true }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn read_lock_pid(path: &Path) -> Option<u32> {
    let raw = fs::read_to_string(path).ok()?;
    raw.trim().parse().ok()
}

fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                false
            } else {
                CloseHandle(handle);
                true
            }
        }
    }
    #[cfg(unix)]
    {
        unsafe { libc_kill(pid) }
    }
}

#[cfg(unix)]
fn libc_kill(pid: u32) -> bool {
    #[link(name = "c")]
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    unsafe { kill(pid as i32, 0) == 0 }
}

fn run_git(git: &Path, root: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new(git)
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .output()
        .map_err(|error| format!("无法运行 git：{error}"))
}

fn git_text(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if stderr.is_empty() {
        stdout
    } else if stdout.is_empty() {
        stderr
    } else {
        format!("{stderr}\n{stdout}")
    }
}

fn git_ok(output: Output) -> Result<String, String> {
    if output.status.success() {
        return Ok(git_text(&output));
    }
    Err(git_text(&output))
}

fn ensure_repo(git: &Path, root: &Path) -> Result<(), String> {
    if root.join(".git").exists() {
        return Ok(());
    }
    git_ok(run_git(git, root, &["init", "-b", "main"])?)?;
    Ok(())
}

fn ensure_remote(git: &Path, root: &Path, remote: &str, url: &str) -> Result<(), String> {
    if url.is_empty() {
        return Ok(());
    }
    let current = run_git(git, root, &["remote", "get-url", remote])?;
    if current.status.success() {
        let existing = String::from_utf8_lossy(&current.stdout).trim().to_owned();
        if existing != url {
            git_ok(run_git(git, root, &["remote", "set-url", remote, url])?)?;
        }
        return Ok(());
    }
    git_ok(run_git(git, root, &["remote", "add", remote, url])?)?;
    Ok(())
}

fn commit_tree(git: &Path, root: &Path) -> Result<bool, String> {
    for path in ["pages", ".tie"] {
        if root.join(path).exists() {
            git_ok(run_git(git, root, &["add", "--", path])?)?;
        }
    }
    let diff = run_git(git, root, &["diff", "--cached", "--quiet"])?;
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
            "-c",
            "user.name=Tie",
            "-c",
            "user.email=tie@localhost",
            "commit",
            "-m",
            "tie: sync workspace",
        ],
    )?)?;
    Ok(true)
}

fn current_branch(git: &Path, root: &Path) -> Result<String, String> {
    let name = git_ok(run_git(git, root, &["rev-parse", "--abbrev-ref", "HEAD"])?)?;
    if name.is_empty() || name == "HEAD" {
        Ok("main".to_owned())
    } else {
        Ok(name)
    }
}

fn sync_remote(git: &Path, root: &Path, remote: &str) -> Result<(), String> {
    let listed = git_ok(run_git(git, root, &["remote"])?)?;
    if !listed.split_whitespace().any(|name| name == remote) {
        return Ok(());
    }
    git_ok(run_git(git, root, &["fetch", remote])?)?;
    let branch = current_branch(git, root)?;
    let remote_ref = format!("{remote}/{branch}");
    let exists = run_git(
        git,
        root,
        &["rev-parse", "--verify", "--quiet", &remote_ref],
    )?;
    if !exists.status.success() {
        git_ok(run_git(git, root, &["push", "-u", remote, "HEAD"])?)?;
        return Ok(());
    }
    let pull = run_git(
        git,
        root,
        &["pull", "--rebase", "--autostash", remote, &branch],
    )?;
    if !pull.status.success() {
        let _ = run_git(git, root, &["rebase", "--abort"]);
        return Err(format!(
            "与其他设备内容冲突，已保留本地版本。{}",
            git_text(&pull)
        ));
    }
    git_ok(run_git(git, root, &["push", remote, "HEAD"])?)?;
    Ok(())
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn accepts_common_remote_urls() {
        assert!(validate_remote_url("https://example.com/tie.git").is_ok());
        assert!(validate_remote_url("git@github.com:tie/notes.git").is_ok());
        assert!(validate_remote_url("file:///tmp/tie.git").is_ok());
        assert!(validate_remote_url("notes.git").is_err());
        assert!(validate_remote_url("https://example.com/tie git").is_err());
    }

    #[test]
    fn commits_then_pushes_file_remote() {
        let git = match resolve_git() {
            Ok(path) => path,
            Err(error) => {
                eprintln!("skip git sync test: {error}");
                return;
            }
        };
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tie-sync-{stamp}"));
        let bare = std::env::temp_dir().join(format!("tie-sync-bare-{stamp}.git"));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&bare);
        fs::create_dir_all(root.join("pages")).unwrap();
        fs::create_dir_all(&bare).unwrap();
        fs::write(root.join("pages").join("hello.md"), "# hello\n").unwrap();
        git_ok(run_git(&git, &bare, &["init", "--bare", "-b", "main"]).unwrap()).unwrap();

        let skipped = sync_workspace(&git, &root).unwrap();
        assert_eq!(skipped.mode, "skipped");

        let url = format!("file:///{}", bare.display().to_string().replace('\\', "/"));
        let pushed = enable_and_sync(&git, &root, &url).unwrap();
        assert_eq!(pushed.mode, "synced", "{}", pushed.message);
        assert!(pushed.pushed, "{}", pushed.message);
        let status = read_sync_status(&root).unwrap().expect("status");
        assert_eq!(status.get("state").and_then(|item| item.as_str()), Some("synced"));

        fs::write(root.join("pages").join("hello.md"), "# hello\n\nagain\n").unwrap();
        let again = sync_workspace(&git, &root).unwrap();
        assert!(again.committed, "{}", again.message);
        assert!(again.pushed, "{}", again.message);

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&bare);
    }
}
