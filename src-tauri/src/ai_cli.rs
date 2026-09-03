use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const DEFAULT_TIMEOUT_SECS: u64 = 45;

#[derive(Clone, Copy, PartialEq, Eq)]
enum AiCliClient {
    Claude,
    Codex,
    Cursor,
}

impl AiCliClient {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude-code" | "claudecode" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "cursor" | "agent" | "cursor-agent" => Some(Self::Cursor),
            _ => None,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Cursor => "Cursor",
        }
    }

    fn bin_names(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &["claude"],
            Self::Codex => &["codex"],
            Self::Cursor => &["agent", "cursor-agent"],
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCliClientStatus {
    pub id: String,
    pub label: String,
    /// Binary found on disk / in PATH.
    pub available: bool,
    /// CLI responds and appears authenticated / ready.
    pub connected: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub detail: Option<String>,
    pub custom: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCliStatus {
    pub clients: Vec<AiCliClientStatus>,
    pub searched_at: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiCliCustomPaths {
    pub claude: Option<String>,
    pub codex: Option<String>,
    pub cursor: Option<String>,
}

impl AiCliCustomPaths {
    fn for_client(&self, client: AiCliClient) -> Option<&str> {
        let value = match client {
            AiCliClient::Claude => self.claude.as_deref(),
            AiCliClient::Codex => self.codex.as_deref(),
            AiCliClient::Cursor => self.cursor.as_deref(),
        }?;
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCliTagInput {
    pub title: String,
    pub markdown: String,
    pub existing_tags: Vec<String>,
    pub workspace_tags: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiCliTagSuggestion {
    pub tag: String,
    pub score: f64,
    pub reasons: Vec<String>,
}

fn home_dir(app: Option<&AppHandle>) -> Option<PathBuf> {
    if let Some(app) = app {
        if let Ok(path) = app.path().home_dir() {
            return Some(path);
        }
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn is_executable_candidate(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            return meta.permissions().mode() & 0o111 != 0;
        }
        return false;
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn push_unique(dirs: &mut Vec<PathBuf>, path: PathBuf) {
    if path.as_os_str().is_empty() {
        return;
    }
    if !dirs.iter().any(|item| item == &path) {
        dirs.push(path);
    }
}

fn search_directories(app: Option<&AppHandle>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            push_unique(&mut dirs, dir);
        }
    }
    if let Some(home) = home_dir(app) {
        push_unique(&mut dirs, home.join(".local").join("bin"));
        push_unique(&mut dirs, home.join(".npm-global").join("bin"));
        push_unique(&mut dirs, home.join(".nvm").join("current").join("bin"));
        push_unique(&mut dirs, home.join(".cargo").join("bin"));
        push_unique(&mut dirs, home.join("bin"));
        push_unique(&mut dirs, home.join(".codex").join("bin"));
        // Cursor agent versioned installs
        let cursor_versions = home
            .join(".local")
            .join("share")
            .join("cursor-agent")
            .join("versions");
        if let Ok(entries) = fs::read_dir(&cursor_versions) {
            let mut version_dirs = entries
                .filter_map(|entry| entry.ok().map(|item| item.path()))
                .filter(|path| path.is_dir())
                .collect::<Vec<_>>();
            version_dirs.sort();
            version_dirs.reverse();
            for dir in version_dirs.into_iter().take(8) {
                push_unique(&mut dirs, dir);
            }
        }
        #[cfg(windows)]
        {
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                let local = PathBuf::from(local);
                push_unique(&mut dirs, local.join("Programs").join("cursor"));
                push_unique(&mut dirs, local.join("cursor-agent"));
            }
            if let Some(appdata) = std::env::var_os("APPDATA") {
                push_unique(&mut dirs, PathBuf::from(appdata).join("npm"));
            }
        }
    }
    for dir in [
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/opt/homebrew/bin",
        "/opt/local/bin",
    ] {
        push_unique(&mut dirs, PathBuf::from(dir));
    }
    dirs
}

fn candidate_names(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![
            name.to_owned(),
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![name.to_owned()]
    }
}

fn discover_bin(app: Option<&AppHandle>, names: &[&str]) -> Option<PathBuf> {
    let dirs = search_directories(app);
    for dir in dirs {
        for name in names {
            for candidate_name in candidate_names(name) {
                let candidate = dir.join(&candidate_name);
                if is_executable_candidate(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .chars()
        .take(120)
        .collect()
}

fn run_probe(
    bin: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<(i32, String, String), String> {
    let mut command = Command::new(bin);
    command.args(args);
    if let Some(parent) = bin.parent() {
        let mut paths = vec![parent.to_path_buf()];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            command.env("PATH", joined);
        }
    }
    let output = run_with_timeout(command, None, timeout)?;
    Ok((
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    ))
}

fn probe_version(bin: &Path) -> Option<String> {
    let Ok((code, stdout, stderr)) = run_probe(bin, &["--version"], Duration::from_secs(8)) else {
        return None;
    };
    let text = if !stdout.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    if code != 0 && text.trim().is_empty() {
        return None;
    }
    let line = first_line(&text);
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

fn probe_claude_connected(bin: &Path) -> (bool, String) {
    match run_probe(bin, &["auth", "status"], Duration::from_secs(12)) {
        Ok((_code, stdout, stderr)) => {
            let text = if !stdout.trim().is_empty() {
                stdout
            } else {
                stderr
            };
            if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
                let logged_in = value
                    .get("loggedIn")
                    .and_then(|item| item.as_bool())
                    .unwrap_or(false);
                if logged_in {
                    let method = value
                        .get("authMethod")
                        .and_then(|item| item.as_str())
                        .unwrap_or("authenticated");
                    return (true, format!("已登录（{method}）"));
                }
                return (false, "已找到 CLI，但未登录（claude auth login）".into());
            }
            if text.to_ascii_lowercase().contains("logged")
                && text.to_ascii_lowercase().contains("in")
            {
                return (true, first_line(&text));
            }
            (false, first_line(&text).if_empty("无法解析登录状态"))
        }
        Err(error) => (false, error),
    }
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.trim().is_empty() {
            fallback.to_owned()
        } else {
            self
        }
    }
}

fn probe_cursor_connected(bin: &Path) -> (bool, String) {
    match run_probe(
        bin,
        &["status", "--format", "json"],
        Duration::from_secs(12),
    ) {
        Ok((_code, stdout, stderr)) => {
            let text = if !stdout.trim().is_empty() {
                stdout
            } else {
                stderr
            };
            if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
                let authenticated = value
                    .get("isAuthenticated")
                    .and_then(|item| item.as_bool())
                    .or_else(|| {
                        value
                            .get("status")
                            .and_then(|item| item.as_str())
                            .map(|status| status.eq_ignore_ascii_case("authenticated"))
                    })
                    .unwrap_or(false);
                let message = value
                    .get("message")
                    .and_then(|item| item.as_str())
                    .unwrap_or(if authenticated {
                        "已登录"
                    } else {
                        "未登录"
                    });
                return (authenticated, message.to_owned());
            }
            let lower = text.to_ascii_lowercase();
            if lower.contains("login successful") || lower.contains("logged in") {
                return (true, first_line(&text));
            }
            (false, first_line(&text).if_empty("无法解析登录状态"))
        }
        Err(error) => (false, error),
    }
}

fn probe_codex_connected(bin: &Path) -> (bool, String) {
    // Prefer a lightweight version probe; auth commands vary by Codex builds.
    if probe_version(bin).is_some() {
        match run_probe(bin, &["login", "status"], Duration::from_secs(10)) {
            Ok((_code, stdout, stderr)) => {
                let text = if !stdout.trim().is_empty() {
                    stdout
                } else {
                    stderr
                };
                let lower = text.to_ascii_lowercase();
                if lower.contains("logged")
                    || (lower.contains("login") && lower.contains("success"))
                {
                    return (true, first_line(&text).if_empty("CLI 可用"));
                }
                if lower.contains("not logged") || lower.contains("unauthor") {
                    return (false, first_line(&text).if_empty("未登录"));
                }
                (true, "CLI 可执行（登录态未知）".into())
            }
            Err(_) => (true, "CLI 可执行（登录态未知）".into()),
        }
    } else {
        (false, "CLI 无响应".into())
    }
}

fn resolve_bin(
    app: Option<&AppHandle>,
    client: AiCliClient,
    custom_path: Option<&str>,
) -> (Option<PathBuf>, bool, Option<String>) {
    if let Some(raw) = custom_path.map(str::trim).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(raw);
        if is_executable_candidate(&path) {
            return (Some(path), true, None);
        }
        return (Some(path), true, Some("自定义路径无效或不可执行".into()));
    }
    (discover_bin(app, client.bin_names()), false, None)
}

fn status_for(
    app: Option<&AppHandle>,
    client: AiCliClient,
    custom_path: Option<&str>,
) -> AiCliClientStatus {
    let (resolved, custom, custom_error) = resolve_bin(app, client, custom_path);
    let Some(path) = resolved else {
        return AiCliClientStatus {
            id: client.id().to_owned(),
            label: client.label().to_owned(),
            available: false,
            connected: false,
            path: None,
            version: None,
            detail: Some(format!(
                "未找到可执行文件（已搜索 PATH 与常见安装目录：{}）",
                client.bin_names().join(" / ")
            )),
            custom: false,
        };
    };

    if let Some(error) = custom_error {
        return AiCliClientStatus {
            id: client.id().to_owned(),
            label: client.label().to_owned(),
            available: false,
            connected: false,
            path: Some(path.to_string_lossy().into_owned()),
            version: None,
            detail: Some(error),
            custom,
        };
    }

    let version = probe_version(&path);
    let available = version.is_some();
    let (connected, detail) = if !available {
        (false, "找到文件但 --version 无响应".to_owned())
    } else {
        match client {
            AiCliClient::Claude => probe_claude_connected(&path),
            AiCliClient::Cursor => probe_cursor_connected(&path),
            AiCliClient::Codex => probe_codex_connected(&path),
        }
    };
    let detail = if custom {
        format!("自定义路径 · {detail}")
    } else {
        detail
    };

    AiCliClientStatus {
        id: client.id().to_owned(),
        label: client.label().to_owned(),
        available,
        connected: available && connected,
        path: Some(path.to_string_lossy().into_owned()),
        version,
        detail: Some(detail),
        custom,
    }
}

#[tauri::command]
pub fn ai_cli_status(app: AppHandle, paths: Option<AiCliCustomPaths>) -> AiCliStatus {
    let paths = paths.unwrap_or_default();
    AiCliStatus {
        clients: vec![
            status_for(
                Some(&app),
                AiCliClient::Claude,
                paths.for_client(AiCliClient::Claude),
            ),
            status_for(
                Some(&app),
                AiCliClient::Codex,
                paths.for_client(AiCliClient::Codex),
            ),
            status_for(
                Some(&app),
                AiCliClient::Cursor,
                paths.for_client(AiCliClient::Cursor),
            ),
        ],
        searched_at: chrono_like_iso(),
    }
}

fn chrono_like_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn stamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
        .to_string()
}

fn tag_schema_json() -> String {
    serde_json::to_string(&json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "tags": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "tag": { "type": "string" },
                        "score": { "type": "number" },
                        "reasons": {
                            "type": "array",
                            "items": { "type": "string" }
                        }
                    },
                    "required": ["tag"]
                }
            }
        },
        "required": ["tags"]
    }))
    .unwrap_or_else(|_| "{\"type\":\"object\",\"properties\":{\"tags\":{\"type\":\"array\"}},\"required\":[\"tags\"]}".into())
}

fn build_prompt(input: &AiCliTagInput) -> String {
    let existing = if input.existing_tags.is_empty() {
        "无".to_owned()
    } else {
        input.existing_tags.join("、")
    };
    let workspace = if input.workspace_tags.is_empty() {
        "无".to_owned()
    } else {
        input
            .workspace_tags
            .iter()
            .take(40)
            .cloned()
            .collect::<Vec<_>>()
            .join("、")
    };
    let body = if input.markdown.chars().count() > 6000 {
        format!("{}…", input.markdown.chars().take(6000).collect::<String>())
    } else {
        input.markdown.clone()
    };

    [
        "你是知识库标签提取器。只根据给定标题与正文提取 3-8 个简洁中文或英文标签。",
        "不要解释，不要使用工具，不要读写文件。只输出符合 schema 的 JSON。",
        "JSON 形状：{\"tags\":[{\"tag\":\"标签\",\"score\":10,\"reasons\":[\"原因\"]}]}",
        &format!("已有标签（勿重复）：{existing}"),
        &format!("工作区标签（优先复用）：{workspace}"),
        &format!("标题：{}", input.title.trim()),
        &format!("正文：\n{body}"),
    ]
    .join("\n\n")
}

fn run_with_timeout(
    mut command: Command,
    stdin_data: Option<&[u8]>,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    if stdin_data.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动本地 CLI：{error}"))?;
    let pid = child.id();

    if let Some(data) = stdin_data {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(data)
                .map_err(|error| format!("无法写入本地 CLI stdin：{error}"))?;
        }
    }

    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let output = child.wait_with_output();
        let _ = tx.send(output);
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(format!("本地 CLI 执行失败：{error}")),
        Err(_) => {
            #[cfg(unix)]
            {
                let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F", "/T"])
                    .status();
            }
            let _ = rx.recv_timeout(Duration::from_secs(2));
            Err(format!(
                "本地 CLI 超时（{} 秒）。可改用 OpenAI / Tie 后台，或稍后重试。",
                timeout.as_secs()
            ))
        }
    }
}

fn extract_json_object(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&trimmed[start..=end]).ok()
}

fn suggestions_from_value(value: &Value) -> Vec<AiCliTagSuggestion> {
    let mut candidates = Vec::new();
    if let Some(tags) = value.get("tags") {
        candidates.push(tags);
    }
    if let Some(structured) = value.get("structured_output") {
        if let Some(tags) = structured.get("tags") {
            candidates.push(tags);
        } else {
            candidates.push(structured);
        }
    }
    if let Some(result) = value.get("result") {
        if let Some(text) = result.as_str() {
            if let Some(parsed) = extract_json_object(text) {
                return suggestions_from_value(&parsed);
            }
        } else if result.get("tags").is_some() {
            candidates.push(result);
        }
    }

    for candidate in candidates {
        if let Some(array) = candidate.as_array() {
            let tags = array
                .iter()
                .filter_map(|item| {
                    let tag = item.get("tag")?.as_str()?.trim();
                    if tag.is_empty() {
                        return None;
                    }
                    let score = item
                        .get("score")
                        .and_then(|value| value.as_f64())
                        .unwrap_or(10.0);
                    let reasons = item
                        .get("reasons")
                        .and_then(|value| value.as_array())
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|reason| reason.as_str().map(|text| text.to_owned()))
                                .collect::<Vec<_>>()
                        })
                        .filter(|items| !items.is_empty())
                        .unwrap_or_else(|| vec!["本地 CLI 推荐".into()]);
                    Some(AiCliTagSuggestion {
                        tag: tag.to_owned(),
                        score,
                        reasons,
                    })
                })
                .collect::<Vec<_>>();
            if !tags.is_empty() {
                return tags;
            }
        }
    }
    Vec::new()
}

fn parse_cli_output(stdout: &str, stderr: &str) -> Result<Vec<AiCliTagSuggestion>, String> {
    if let Some(value) = extract_json_object(stdout) {
        let tags = suggestions_from_value(&value);
        if !tags.is_empty() {
            return Ok(tags);
        }
        // Codex --json JSONL: take last object that looks useful
        for line in stdout.lines().rev() {
            if let Ok(event) = serde_json::from_str::<Value>(line) {
                let tags = suggestions_from_value(&event);
                if !tags.is_empty() {
                    return Ok(tags);
                }
                if let Some(text) = event
                    .pointer("/item/text")
                    .or_else(|| event.pointer("/item/content"))
                    .and_then(|value| value.as_str())
                {
                    if let Some(parsed) = extract_json_object(text) {
                        let tags = suggestions_from_value(&parsed);
                        if !tags.is_empty() {
                            return Ok(tags);
                        }
                    }
                }
            }
        }
    }

    let detail = stderr.trim();
    if !detail.is_empty() {
        return Err(format!("本地 CLI 未返回可用标签。{detail}"));
    }
    Err("本地 CLI 未返回可用标签。".into())
}

fn prepare_workdir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("tie-ai-cli-{}", stamp()));
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn cleanup_workdir(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

fn run_claude(
    bin: &Path,
    workdir: &Path,
    prompt: &str,
    model: Option<&str>,
) -> Result<Vec<AiCliTagSuggestion>, String> {
    let schema = tag_schema_json();
    let mut command = Command::new(bin);
    command
        .current_dir(workdir)
        .arg("-p")
        .arg(prompt)
        .arg("--output-format")
        .arg("json")
        .arg("--json-schema")
        .arg(&schema)
        .arg("--tools")
        .arg("")
        .arg("--permission-mode")
        .arg("dontAsk")
        .arg("--system-prompt")
        .arg("你只做标签提取。禁止使用工具。只输出符合 JSON Schema 的对象。");
    if let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--model").arg(model);
    }
    let started = Instant::now();
    let output = run_with_timeout(command, None, Duration::from_secs(DEFAULT_TIMEOUT_SECS))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() && stdout.trim().is_empty() {
        return Err(format!(
            "Claude Code 退出码 {}（耗时 {}ms）：{}",
            output.status.code().unwrap_or(-1),
            started.elapsed().as_millis(),
            stderr.trim().chars().take(400).collect::<String>()
        ));
    }
    parse_cli_output(&stdout, &stderr)
}

fn run_cursor(
    bin: &Path,
    workdir: &Path,
    prompt: &str,
    model: Option<&str>,
) -> Result<Vec<AiCliTagSuggestion>, String> {
    let mut command = Command::new(bin);
    command
        .current_dir(workdir)
        .arg("-p")
        .arg(prompt)
        .arg("--output-format")
        .arg("json")
        .arg("--mode")
        .arg("ask")
        .arg("--workspace")
        .arg(workdir)
        .arg("--trust");
    if let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--model").arg(model);
    }
    let output = run_with_timeout(command, None, Duration::from_secs(DEFAULT_TIMEOUT_SECS))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() && stdout.trim().is_empty() {
        return Err(format!(
            "Cursor Agent 退出码 {}：{}",
            output.status.code().unwrap_or(-1),
            stderr.trim().chars().take(400).collect::<String>()
        ));
    }
    parse_cli_output(&stdout, &stderr)
}

fn run_codex(
    bin: &Path,
    workdir: &Path,
    prompt: &str,
    model: Option<&str>,
) -> Result<Vec<AiCliTagSuggestion>, String> {
    let schema_path = workdir.join("tie-tags.schema.json");
    {
        let mut file = fs::File::create(&schema_path).map_err(|error| error.to_string())?;
        file.write_all(tag_schema_json().as_bytes())
            .map_err(|error| error.to_string())?;
    }

    let mut command = Command::new(bin);
    command
        .current_dir(workdir)
        .arg("exec")
        .arg("--skip-git-repo-check")
        .arg("--sandbox")
        .arg("read-only")
        .arg("--ephemeral")
        .arg("--output-schema")
        .arg(&schema_path)
        .arg("-");
    if let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--model").arg(model);
    }
    let output = run_with_timeout(
        command,
        Some(prompt.as_bytes()),
        Duration::from_secs(DEFAULT_TIMEOUT_SECS),
    )?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() && stdout.trim().is_empty() {
        return Err(format!(
            "Codex 退出码 {}：{}",
            output.status.code().unwrap_or(-1),
            stderr.trim().chars().take(400).collect::<String>()
        ));
    }
    parse_cli_output(&stdout, &stderr)
}

#[tauri::command]
pub fn ai_cli_suggest_tags(
    app: AppHandle,
    client: String,
    input: AiCliTagInput,
    model: Option<String>,
    custom_path: Option<String>,
) -> Result<Vec<AiCliTagSuggestion>, String> {
    let client = AiCliClient::parse(&client).ok_or_else(|| format!("未知本地 CLI：{client}"))?;
    let custom = custom_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (resolved, _custom, custom_error) = resolve_bin(Some(&app), client, custom);
    if let Some(error) = custom_error {
        return Err(error);
    }
    let bin = resolved.ok_or_else(|| {
        format!(
            "未找到 {}（已搜索 PATH 与常见安装目录：{}）。也可在设置中填写自定义路径。",
            client.label(),
            client.bin_names().join(" / ")
        )
    })?;

    let workdir = prepare_workdir()?;
    let prompt = build_prompt(&input);
    let model_ref = model.as_deref();
    let result = match client {
        AiCliClient::Claude => run_claude(&bin, &workdir, &prompt, model_ref),
        AiCliClient::Codex => run_codex(&bin, &workdir, &prompt, model_ref),
        AiCliClient::Cursor => run_cursor(&bin, &workdir, &prompt, model_ref),
    };
    cleanup_workdir(&workdir);
    result
}
