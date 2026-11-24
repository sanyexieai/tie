use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

const SERVER_NAME: &str = "tie";

#[derive(Clone, Copy, PartialEq, Eq)]
enum AgentClient {
    Codex,
    Cursor,
    Claude,
}

impl AgentClient {
    fn parse(id: &str) -> Option<Self> {
        match id.trim().to_ascii_lowercase().as_str() {
            "codex" => Some(Self::Codex),
            "cursor" => Some(Self::Cursor),
            "claude" | "claude-code" | "claudecode" => Some(Self::Claude),
            _ => None,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Cursor => "cursor",
            Self::Claude => "claude",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Cursor => "Cursor",
            Self::Claude => "Claude Code",
        }
    }

    fn all() -> [Self; 3] {
        [Self::Codex, Self::Cursor, Self::Claude]
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentClientStatus {
    pub id: String,
    pub label: String,
    pub configured: bool,
    pub workspace_path: Option<String>,
    pub config_path: String,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpStatus {
    pub node_available: bool,
    pub mcp_ready: bool,
    pub server_path: Option<String>,
    pub mcp_error: Option<String>,
    pub clients: Vec<AgentClientStatus>,
}

/// Backward-compatible shape used by older frontend callers.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMcpStatus {
    pub configured: bool,
    pub workspace_path: Option<String>,
    pub server_path: Option<String>,
    pub config_path: String,
    pub node_available: bool,
}

fn home_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .home_dir()
        .map_err(|error| format!("无法定位用户主目录：{error}"))
}

fn codex_home(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var("CODEX_HOME") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    Ok(home_dir(app)?.join(".codex"))
}

fn codex_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(codex_home(app)?.join("config.toml"))
}

fn cursor_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(home_dir(app)?.join(".cursor").join("mcp.json"))
}

fn claude_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(home_dir(app)?.join(".claude.json"))
}

fn config_path_for(app: &AppHandle, client: AgentClient) -> Result<PathBuf, String> {
    match client {
        AgentClient::Codex => codex_config_path(app),
        AgentClient::Cursor => cursor_config_path(app),
        AgentClient::Claude => claude_config_path(app),
    }
}

fn installed_mcp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("mcp");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn path_separator() -> char {
    if cfg!(windows) { ';' } else { ':' }
}

fn command_path_env() -> String {
    let sep = path_separator();
    let mut parts = Vec::new();
    if let Ok(current) = std::env::var("PATH") {
        for item in current.split(sep) {
            if !item.is_empty() && !parts.iter().any(|existing| existing == item) {
                parts.push(item.to_owned());
            }
        }
    }

    #[cfg(windows)]
    {
        let extra = [
            r"C:\Program Files\nodejs",
            r"C:\Program Files (x86)\nodejs",
        ];
        for item in extra {
            if Path::new(item).is_dir() && !parts.iter().any(|existing| existing == item) {
                parts.push(item.to_owned());
            }
        }
        if let Ok(profile) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            for item in [
                format!(r"{profile}\AppData\Roaming\npm"),
                format!(r"{profile}\AppData\Local\fnm_multishells"),
                format!(r"{profile}\.fnm\current"),
                format!(r"{profile}\scoop\apps\nodejs\current"),
                format!(r"{profile}\scoop\shims"),
                format!(r"{profile}\.volta\bin"),
                format!(r"{profile}\.asdf\shims"),
            ] {
                if Path::new(&item).is_dir() && !parts.iter().any(|existing| existing == &item) {
                    parts.push(item);
                }
            }
            // nvm-windows: %NVM_SYMLINK% or latest under %NVM_HOME%
            if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
                if Path::new(&nvm_symlink).is_dir()
                    && !parts.iter().any(|existing| existing == &nvm_symlink)
                {
                    parts.push(nvm_symlink);
                }
            }
            if let Ok(nvm_home) = std::env::var("NVM_HOME") {
                if !parts.iter().any(|existing| existing == &nvm_home) {
                    parts.push(nvm_home);
                }
            }
            let local_programs = format!(r"{profile}\AppData\Local\Programs\node");
            if Path::new(&local_programs).is_dir()
                && !parts.iter().any(|existing| existing == &local_programs)
            {
                parts.push(local_programs);
            }
        }
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            let nodejs = PathBuf::from(&program_files).join("nodejs");
            let text = nodejs.to_string_lossy().into_owned();
            if nodejs.is_dir() && !parts.iter().any(|existing| existing == &text) {
                parts.push(text);
            }
        }
    }

    #[cfg(not(windows))]
    {
        for item in [
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/snap/bin",
            "/opt/homebrew/bin",
            "/home/linuxbrew/.linuxbrew/bin",
        ] {
            if !parts.iter().any(|existing| existing == item) {
                parts.push(item.to_owned());
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            for item in [
                format!("{home}/.local/bin"),
                format!("{home}/.nvm/current/bin"),
                format!("{home}/.fnm/current/bin"),
                format!("{home}/.volta/bin"),
                format!("{home}/.asdf/shims"),
            ] {
                if Path::new(&item).is_dir() && !parts.iter().any(|existing| existing == &item) {
                    parts.push(item);
                }
            }
        }
    }

    parts.join(&sep.to_string())
}

fn binary_name_variants(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        // node 优先 .exe（Codex CreateProcess 对 .cmd 不稳定）；npm 仍优先 .cmd
        if name.eq_ignore_ascii_case("node") {
            return vec![
                format!("{name}.exe"),
                name.to_owned(),
                format!("{name}.cmd"),
                format!("{name}.bat"),
            ];
        }
        // Windows 上 npm 通常是 npm.cmd；CreateProcess 对 .cmd 需走 cmd 或完整路径
        vec![
            format!("{name}.cmd"),
            format!("{name}.exe"),
            format!("{name}.bat"),
            name.to_owned(),
        ]
    }
    #[cfg(not(windows))]
    {
        vec![name.to_owned()]
    }
}

fn looks_like_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(windows)]
    {
        match path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref()
        {
            Some("exe") | Some("cmd") | Some("bat") | Some("com") => true,
            _ => false,
        }
    }
    #[cfg(not(windows))]
    {
        true
    }
}

fn resolve_binary(name: &str) -> Option<PathBuf> {
    let variants = binary_name_variants(name);

    #[cfg(windows)]
    let hardcoded: Vec<PathBuf> = {
        let mut list = Vec::new();
        for base in [
            PathBuf::from(r"C:\Program Files\nodejs"),
            PathBuf::from(r"C:\Program Files (x86)\nodejs"),
        ] {
            for variant in &variants {
                list.push(base.join(variant));
            }
        }
        if let Ok(profile) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            for base in [
                format!(r"{profile}\AppData\Roaming\npm"),
                format!(r"{profile}\scoop\shims"),
                format!(r"{profile}\.volta\bin"),
                format!(r"{profile}\AppData\Local\Programs\node"),
            ] {
                for variant in &variants {
                    list.push(PathBuf::from(&base).join(variant));
                }
            }
            if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
                for variant in &variants {
                    list.push(PathBuf::from(&nvm_symlink).join(variant));
                }
            }
        }
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            for variant in &variants {
                list.push(PathBuf::from(&program_files).join("nodejs").join(variant));
            }
        }
        list
    };

    #[cfg(not(windows))]
    let hardcoded: Vec<PathBuf> = {
        let mut list = Vec::new();
        for base in [
            "/usr/bin",
            "/usr/local/bin",
            "/bin",
            "/snap/bin",
            "/opt/homebrew/bin",
        ] {
            list.push(PathBuf::from(base).join(name));
        }
        if let Ok(home) = std::env::var("HOME") {
            for base in [
                format!("{home}/.local/bin"),
                format!("{home}/.nvm/current/bin"),
                format!("{home}/.fnm/current/bin"),
                format!("{home}/.volta/bin"),
                format!("{home}/.asdf/shims"),
            ] {
                list.push(PathBuf::from(base).join(name));
            }
        }
        list
    };

    for path in hardcoded {
        if looks_like_executable(&path) {
            return Some(path);
        }
    }

    // 在增强 PATH 中逐项查找
    for dir in command_path_env().split(path_separator()) {
        if dir.is_empty() {
            continue;
        }
        for variant in &variants {
            let path = PathBuf::from(dir).join(variant);
            if looks_like_executable(&path) {
                return Some(path);
            }
        }
    }

    #[cfg(windows)]
    {
        let script = format!(
            "where.exe {name} 2>NUL & where.exe {name}.cmd 2>NUL & where.exe {name}.exe 2>NUL"
        );
        let output = Command::new("cmd")
            .args(["/C", &script])
            .env("PATH", command_path_env())
            .output()
            .ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let path = PathBuf::from(line.trim());
            if looks_like_executable(&path) {
                return Some(path);
            }
        }
        None
    }

    #[cfg(not(windows))]
    {
        let output = Command::new("sh")
            .args(["-lc", &format!("command -v {name}")])
            .env("PATH", command_path_env())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if path.is_empty() {
            return None;
        }
        let path = PathBuf::from(path);
        looks_like_executable(&path).then_some(path)
    }
}

fn node_bin() -> Option<PathBuf> {
    resolve_binary("node")
}

fn npm_bin() -> Option<PathBuf> {
    resolve_binary("npm")
}

fn configure_command_path(command: &mut Command) {
    command.env("PATH", command_path_env());
}

fn node_available() -> bool {
    let Some(node) = node_bin() else {
        return false;
    };
    let mut command = Command::new(node);
    configure_command_path(&mut command);
    command
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn copy_node_modules(from: &Path, to: &Path) -> Result<(), String> {
    let source = from.join("node_modules");
    if !source.is_dir() {
        return Err("源包没有 node_modules".into());
    }
    let target = to.join("node_modules");
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
    }
    copy_dir_recursive_including_node_modules(&source, &target)
}

fn copy_dir_recursive_including_node_modules(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(from).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_dir_recursive_including_node_modules(&source, &target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(&source, &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn ensure_mcp_dependencies(source: &Path, target: &Path) -> Result<(), String> {
    let node_modules = target.join("node_modules");
    if node_modules.is_dir() {
        return Ok(());
    }

    // 优先复用源包已安装依赖，避免 GUI 环境下 npm PATH / 网络问题
    if source.join("node_modules").is_dir() {
        copy_node_modules(source, target)?;
        if node_modules.is_dir() {
            return Ok(());
        }
    }

    let Some(npm) = npm_bin() else {
        return Err(
            "未找到 npm。请安装 Node.js（含 npm），或从终端启动 Tie 后再接入；也可手动选择已含 node_modules 的 tie-mcp 目录。"
                .into(),
        );
    };

    let output = {
        let mut command = Command::new(&npm);
        configure_command_path(&mut command);
        // Windows 上 npm.cmd 需要可解析的工作目录与 PATH
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command
            .args(["install", "--omit=dev"])
            .current_dir(target)
            .output()
            .map_err(|error| {
                format!(
                    "无法执行 npm install（{}）：{error}。请确认已安装 Node.js（含 npm），或手动选择已含 node_modules 的 tie-mcp 目录。",
                    npm.display()
                )
            })?
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("退出码 {}", output.status.code().unwrap_or(-1))
        };
        return Err(format!("npm install 失败：{detail}"));
    }
    if !node_modules.is_dir() {
        return Err("npm install 完成但未生成 node_modules。".into());
    }
    Ok(())
}

fn escape_toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
}

/// Windows `canonicalize` 会产出 `\\?\C:\...`；写入外部配置前去掉。
fn path_for_external_config(path: &Path) -> PathBuf {
    tie_storage::fs_path::for_external_config(path)
}

fn parse_configured_workspace_toml(config: &str) -> Option<String> {
    let mut in_env = false;
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed == "[mcp_servers.tie.env]" {
            in_env = true;
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_env = false;
            continue;
        }
        if in_env && trimmed.starts_with("TIE_WORKSPACE") {
            if let Some((_, value)) = trimmed.split_once('=') {
                let raw = value.trim().trim_matches('"');
                if !raw.is_empty() {
                    return Some(raw.to_owned());
                }
            }
        }
    }
    None
}

fn parse_configured_workspace_json(config: &str) -> Option<String> {
    let value: Value = serde_json::from_str(config).ok()?;
    let env = value.get("mcpServers")?.get(SERVER_NAME)?.get("env")?;
    env.get("TIE_WORKSPACE")
        .and_then(|item| item.as_str())
        .filter(|item| !item.is_empty())
        .map(|item| item.to_owned())
}

fn parse_mcp_url_toml(config: &str) -> Option<String> {
    let mut in_server = false;
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed == "[mcp_servers.tie]" {
            in_server = true;
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_server = false;
            continue;
        }
        if in_server && trimmed.starts_with("url") {
            let raw = trimmed.split_once('=')?.1.trim().trim_matches('"');
            if raw.starts_with("http://") || raw.starts_with("https://") {
                return Some(raw.to_owned());
            }
        }
    }
    None
}

fn parse_mcp_url_json(config: &str) -> Option<String> {
    let url = serde_json::from_str::<Value>(config)
        .ok()?
        .get("mcpServers")?
        .get(SERVER_NAME)?
        .get("url")?
        .as_str()?
        .trim()
        .to_owned();
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url)
    } else {
        None
    }
}

fn tie_entry_uses_command_toml(config: &str) -> bool {
    let mut in_server = false;
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed == "[mcp_servers.tie]" || trimmed.starts_with("[mcp_servers.tie.") {
            in_server = true;
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_server = false;
            continue;
        }
        if in_server && (trimmed.starts_with("command") || trimmed.starts_with("args")) {
            return true;
        }
    }
    false
}

fn tie_entry_is_local_mcp_toml(config: &str) -> bool {
    let mut in_server = false;
    let mut command = String::new();
    let mut args = String::new();
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed == "[mcp_servers.tie]" {
            in_server = true;
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if in_server {
                break;
            }
            continue;
        }
        if !in_server {
            continue;
        }
        if let Some((_, value)) = trimmed.split_once('=') {
            let key = trimmed.split_once('=').map(|(key, _)| key.trim()).unwrap_or("");
            if key == "command" {
                command = value.trim().trim_matches('"').to_lowercase();
            }
            if key == "args" {
                args = value.to_lowercase();
            }
        }
    }
    !command.contains("node") && command.contains("tie") && args.contains("mcp")
}

fn tie_entry_is_local_mcp_json(config: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(config) else {
        return false;
    };
    let Some(entry) = value.get("mcpServers").and_then(|item| item.get(SERVER_NAME)) else {
        return false;
    };
    let command = entry.get("command").and_then(Value::as_str).unwrap_or("").to_lowercase();
    let args = entry.get("args").map(|item| item.to_string()).unwrap_or_default().to_lowercase();
    !command.contains("node") && command.contains("tie") && args.contains("mcp")
}

fn tie_entry_uses_command_json(config: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(config) else {
        return false;
    };
    let Some(entry) = value.get("mcpServers").and_then(|item| item.get(SERVER_NAME)) else {
        return false;
    };
    entry.get("command").is_some() || entry.get("args").is_some()
}

fn strip_mcp_server_block(config: &str) -> String {
    let normalized = config.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut out = Vec::new();
    let mut i = 0;
    let is_own = |line: &str| {
        let trimmed = line.trim();
        trimmed == "[mcp_servers.tie]" || trimmed.starts_with("[mcp_servers.tie.")
    };
    while i < lines.len() {
        if is_own(lines[i]) {
            i += 1;
            while i < lines.len() {
                let trimmed = lines[i].trim();
                if trimmed.starts_with('[') && trimmed.ends_with(']') {
                    if is_own(lines[i]) {
                        i += 1;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            continue;
        }
        out.push(lines[i]);
        i += 1;
    }
    let mut text = out.join("\n");
    while text.contains("\n\n\n") {
        text = text.replace("\n\n\n", "\n\n");
    }
    text.trim().to_owned()
}

fn normalize_mcp_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(url.to_owned())
    } else {
        Err("MCP 地址需要以 http:// 或 https:// 开头".into())
    }
}

fn http_mcp_block(url: &str) -> String {
    format!(
        "[mcp_servers.tie]\nurl = {}\nenabled = true\n",
        escape_toml_string(url)
    )
}

fn change_actor_label(agent: &str) -> String {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default();
    let host = host.trim();
    if host.is_empty() {
        agent.to_owned()
    } else {
        format!("{agent} · {host}")
    }
}

fn local_mcp_env(workspace: &Path, actor: &str) -> Vec<(String, String)> {
    let mut env = vec![(
        "TIE_WORKSPACE".to_owned(),
        path_for_external_config(workspace).to_string_lossy().into_owned(),
    )];
    let actor = actor.trim();
    if !actor.is_empty() {
        env.push(("TIE_ACTOR".to_owned(), actor.to_owned()));
    }
    env.push(("PATH".into(), command_path_env()));
    #[cfg(windows)]
    {
        for key in ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR"] {
            if let Ok(value) = std::env::var(key) {
                if !value.is_empty() {
                    env.push((key.to_owned(), value));
                }
            }
        }
    }
    env
}

fn local_mcp_block(command: &str, workspace: &Path, actor: &str) -> String {
    let mut block = format!(
        "[mcp_servers.tie]\ncommand = {}\nargs = [\"mcp\"]\nenabled = true\n\n[mcp_servers.tie.env]\n",
        escape_toml_string(command)
    );
    for (key, value) in local_mcp_env(workspace, actor) {
        block.push_str(&format!("{} = {}\n", key, escape_toml_string(&value)));
    }
    block
}

fn local_mcp_json(command: &str, workspace: &Path, actor: &str, with_type: bool) -> Value {
    let mut entry = Map::new();
    if with_type {
        entry.insert("type".into(), json!("stdio"));
    }
    entry.insert("command".into(), json!(command));
    entry.insert("args".into(), json!(["mcp"]));
    let mut env_map = Map::new();
    for (key, value) in local_mcp_env(workspace, actor) {
        env_map.insert(key, json!(value));
    }
    entry.insert("env".into(), Value::Object(env_map));
    Value::Object(entry)
}

fn current_app_exe() -> Option<PathBuf> {
    std::env::current_exe().ok().map(|path| path.canonicalize().unwrap_or(path))
}

fn same_file(path: &Path, app: &Path) -> bool {
    let candidate = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    candidate == *app
}

fn look_like_tie_cli_name(name: &str) -> bool {
    #[cfg(windows)]
    {
        let lower = name.to_ascii_lowercase();
        lower == "tie-cli.exe" || (lower.starts_with("tie-") && lower.ends_with(".exe") && lower != "tie.exe")
    }
    #[cfg(not(windows))]
    {
        name == "tie-cli" || (name.starts_with("tie-") && !name.contains('.'))
    }
}

fn binary_serves_mcp(path: &Path) -> bool {
    let Ok(output) = Command::new(path).arg("--help").output() else {
        return false;
    };
    if !output.status.success() && output.stdout.is_empty() {
        return false;
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    text.lines().any(|line| line.trim().starts_with("mcp"))
}

fn find_tie_cli_in_dir(dir: &Path) -> Option<PathBuf> {
    let app = current_app_exe();
    let reject = |path: &Path| app.as_ref().is_some_and(|exe| same_file(path, exe));
    let mut found = Vec::new();
    let preferred = dir.join(if cfg!(windows) { "tie-cli.exe" } else { "tie-cli" });
    if preferred.is_file() && !reject(&preferred) {
        found.push(preferred);
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || reject(&path) || found.iter().any(|item| item == &path) {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if look_like_tie_cli_name(&name) {
                found.push(path);
            }
        }
    }
    found.into_iter().find(|path| binary_serves_mcp(path))
}

fn resolve_tie_cli_binary(app: Option<&AppHandle>) -> Option<PathBuf> {
    let running_app = current_app_exe();
    if let Ok(from_env) = std::env::var("TIE_CLI") {
        let path = PathBuf::from(from_env.trim());
        if path.is_file() && running_app.as_ref().is_none_or(|exe| !same_file(&path, exe)) {
            return Some(path);
        }
    }

    let mut dirs: Vec<PathBuf> = Vec::new();
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    dirs.push(manifest_dir.join("binaries"));
    for profile in ["release", "debug"] {
        dirs.push(manifest_dir.join("target").join(profile));
    }
    if let Some(app) = app {
        if let Ok(resource) = app.path().resource_dir() {
            dirs.push(resource.join("binaries"));
            dirs.push(resource);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
        }
    }

    for dir in dirs {
        if let Some(found) = find_tie_cli_in_dir(&dir) {
            return Some(found);
        }
    }

    // Last resort: PATH
    let which = if cfg!(windows) { "where" } else { "which" };
    let output = Command::new(which).arg("tie").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| path.is_file() && binary_serves_mcp(path))
}

fn http_mcp_json(url: &str, with_type: bool) -> Value {
    let mut entry = Map::new();
    if with_type {
        entry.insert("type".into(), json!("http"));
    }
    entry.insert("url".into(), json!(url));
    Value::Object(entry)
}

fn backup_file(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let stamp = chrono_like_stamp();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    let backup = path.with_file_name(format!("{file_name}.bak-tie-{stamp}"));
    fs::copy(path, backup).map_err(|error| error.to_string())?;
    Ok(())
}

enum TieMcpLaunch<'a> {
    Http(&'a str),
    Local {
        command: &'a str,
        workspace: &'a Path,
        actor: &'a str,
    },
}

fn write_codex_config(app: &AppHandle, launch: TieMcpLaunch<'_>) -> Result<(), String> {
    let config_path = codex_config_path(app)?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let existing = if config_path.is_file() {
        fs::read_to_string(&config_path).map_err(|error| error.to_string())?
    } else {
        String::new()
    };
    backup_file(&config_path)?;
    let cleaned = strip_mcp_server_block(&existing);
    let block = match launch {
        TieMcpLaunch::Http(url) => http_mcp_block(url),
        TieMcpLaunch::Local { command, workspace, actor } => local_mcp_block(command, workspace, actor),
    };
    let next = if cleaned.is_empty() {
        block
    } else {
        format!("{cleaned}\n\n{block}")
    };
    fs::write(&config_path, format!("{}\n", next.trim_end())).map_err(|error| error.to_string())
}

fn upsert_json_mcp_config(
    config_path: &Path,
    launch: TieMcpLaunch<'_>,
    with_type: bool,
) -> Result<(), String> {
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut root = if config_path.is_file() {
        let existing = fs::read_to_string(config_path).map_err(|error| error.to_string())?;
        if existing.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&existing)
                .map_err(|error| format!("无法解析 {}: {error}", config_path.display()))?
        }
    } else {
        json!({})
    };

    if !root.is_object() {
        return Err(format!(
            "{} 根节点必须是 JSON 对象，无法安全写入 MCP 配置。",
            config_path.display()
        ));
    }

    backup_file(config_path)?;

    let servers = root
        .as_object_mut()
        .ok_or_else(|| "无效的 MCP JSON 根对象".to_owned())?
        .entry("mcpServers")
        .or_insert_with(|| json!({}));

    if !servers.is_object() {
        *servers = json!({});
    }

    let servers = servers.as_object_mut().unwrap();
    let entry = match launch {
        TieMcpLaunch::Http(url) => http_mcp_json(url, with_type),
        TieMcpLaunch::Local { command, workspace, actor } => local_mcp_json(command, workspace, actor, with_type),
    };
    servers.insert(SERVER_NAME.to_owned(), entry);

    let pretty = serde_json::to_string_pretty(&root).map_err(|error| error.to_string())?;
    fs::write(config_path, format!("{pretty}\n")).map_err(|error| error.to_string())
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(from).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            if entry.file_name() == *"node_modules" {
                continue;
            }
            copy_dir_recursive(&source, &target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(&source, &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn hash_file(path: &Path) -> Option<u64> {
    fs::read(path).ok().map(|bytes| hash_bytes(&bytes))
}

fn append_tree_hashes(root: &Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut names = entries
        .filter_map(|entry| entry.ok())
        .collect::<Vec<_>>();
    names.sort_by_key(|entry| entry.file_name());
    for entry in names {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if path.is_dir() {
            if name == "node_modules" || name == "test" {
                continue;
            }
            append_tree_hashes(&path, &rel, out);
        } else if let Some(hash) = hash_file(&path) {
            out.push(format!("{rel}:{hash:016x}"));
        }
    }
}

/// Content fingerprint of the packaged MCP sources (ignores node_modules / tests).
fn mcp_runtime_fingerprint(source: &Path) -> String {
    let mut parts = Vec::new();
    if let Some(hash) = hash_file(&source.join("package.json")) {
        parts.push(format!("package.json:{hash:016x}"));
    }
    if let Some(hash) = hash_file(&source.join("package-lock.json")) {
        parts.push(format!("package-lock.json:{hash:016x}"));
    }
    if let Some(hash) = hash_file(&source.join("SKILL.md")) {
        parts.push(format!("SKILL.md:{hash:016x}"));
    }
    append_tree_hashes(&source.join("src"), "src", &mut parts);
    append_tree_hashes(&source.join("skills"), "skills", &mut parts);
    parts.sort();
    parts.join("|")
}

fn mcp_runtime_stamp_path(target: &Path) -> PathBuf {
    target.join(".tie-mcp-runtime-stamp")
}

fn package_lock_fingerprint(source: &Path) -> String {
    hash_file(&source.join("package-lock.json"))
        .map(|hash| format!("{hash:016x}"))
        .unwrap_or_default()
}

fn ensure_mcp_runtime(app: &AppHandle) -> Result<PathBuf, String> {
    if !node_available() {
        return Err(
            "未检测到 Node.js。接入 Agent MCP 需要本机已安装 node，并在 PATH 中可用。".into(),
        );
    }
    let source = resolve_mcp_package_source(app)?;
    let target = installed_mcp_dir(app)?;
    let target_server = target.join("src").join("server.js");
    let fingerprint = mcp_runtime_fingerprint(&source);
    let stamp_path = mcp_runtime_stamp_path(&target);
    let previous_stamp = fs::read_to_string(&stamp_path).unwrap_or_default();
    let previous_lock = previous_stamp
        .split('|')
        .find_map(|part| part.strip_prefix("package-lock.json:"))
        .unwrap_or("")
        .to_owned();
    let current_lock = package_lock_fingerprint(&source);
    let needs_copy = !target_server.is_file() || previous_stamp.trim() != fingerprint;

    if needs_copy {
        copy_dir_recursive(&source, &target)?;
        // 依赖锁定变更时强制重装，避免沿用旧 node_modules
        if !current_lock.is_empty() && current_lock != previous_lock {
            let node_modules = target.join("node_modules");
            if node_modules.is_dir() {
                let _ = fs::remove_dir_all(&node_modules);
            }
        }
    }

    ensure_mcp_dependencies(&source, &target)?;

    if !target_server.is_file() {
        return Err(format!("MCP 入口不存在：{}", target_server.display()));
    }
    fs::write(&stamp_path, &fingerprint).map_err(|error| error.to_string())?;
    Ok(path_for_external_config(&target_server))
}

/// Best-effort：启动时把安装包内更新后的 tie-mcp 同步到应用数据目录。
/// Agent 配置已指向该目录时，无需再点「接入」即可用上新逻辑；仍需新开 Agent 会话加载。
pub fn refresh_installed_mcp_runtime(app: &AppHandle) -> Result<bool, String> {
    let source = match resolve_mcp_package_source(app) {
        Ok(path) => path,
        Err(_) => return Ok(false),
    };
    let target = installed_mcp_dir(app)?;
    let stamp_path = mcp_runtime_stamp_path(&target);
    let fingerprint = mcp_runtime_fingerprint(&source);
    let previous = fs::read_to_string(&stamp_path).unwrap_or_default();
    // 从未接入过也预热一份运行时，方便下次接入更快
    if previous.trim() == fingerprint && target.join("src").join("server.js").is_file() {
        return Ok(false);
    }
    if !node_available() {
        return Ok(false);
    }
    ensure_mcp_runtime(app)?;
    Ok(true)
}

fn collect_skill_workspaces(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut push = |raw: PathBuf| {
        let Ok(workspace) = validate_workspace(&raw) else {
            return;
        };
        if !out.iter().any(|item| item == &workspace) {
            out.push(workspace);
        }
    };

    for client in AgentClient::all() {
        if let Ok(status) = client_status(app, client) {
            if let Some(path) = status.workspace_path {
                push(PathBuf::from(path));
            }
        }
    }

    if let Ok((sources, _)) = crate::common::workspace_sources(app) {
        for source in sources {
            if source.kind == "local" || source.kind == "smb" {
                push(PathBuf::from(source.path));
            }
        }
    }

    out
}

/// 启动 / 更新后：刷新 MCP 运行时，并用安装包模板覆盖各工作区打包 Skill（tie-memory + skills/*），再同步到 Agent Skill 目录。
/// Skill 文件可用 ≠ 每次更新都要跑；Agent 收尾由版本化 migration 目录决定（见 tie-update）。
pub fn refresh_mcp_and_skills_on_startup(app: &AppHandle) -> Result<(), String> {
    match refresh_installed_mcp_runtime(app) {
        Ok(true) => eprintln!("[tie] MCP runtime refreshed from package"),
        Ok(false) => {}
        Err(error) => eprintln!("[tie] MCP runtime refresh skipped: {error}"),
    }

    let workspaces = collect_skill_workspaces(app);
    if workspaces.is_empty() {
        return Ok(());
    }

    let clients = AgentClient::all().to_vec();
    for workspace in workspaces {
        match ensure_workspace_packaged_skills(app, &workspace) {
            Ok(names) if !names.is_empty() => eprintln!(
                "[tie] Skill templates overwritten ({}): {}",
                names.join(", "),
                workspace.join(".agents").join("skills").display()
            ),
            Ok(_) => {}
            Err(error) => eprintln!(
                "[tie] Skill template sync skipped ({}): {error}",
                workspace.display()
            ),
        }
        if let Err(error) = sync_workspace_skills(app, &workspace, &clients) {
            eprintln!(
                "[tie] Skill agent sync skipped ({}): {error}",
                workspace.display()
            );
        }
    }
    Ok(())
}

fn mcp_source_override_path(app: &AppHandle) -> Option<PathBuf> {
    let file = app.path().app_data_dir().ok()?.join("mcp-source-override");
    if file.is_file() {
        let content = fs::read_to_string(&file).ok()?;
        let path = PathBuf::from(content.trim());
        if path.join("src").join("server.js").is_file() {
            return Some(path);
        }
    }
    None
}

fn save_mcp_source_override(app: &AppHandle, path: &Path) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(
        dir.join("mcp-source-override"),
        path.to_string_lossy().as_bytes(),
    )
    .map_err(|e| e.to_string())
}

fn ancestors_scan(start: &Path) -> Vec<PathBuf> {
    let mut results = Vec::new();
    let mut dir = start.to_path_buf();
    for _ in 0..10 {
        let candidate = dir.join("packages").join("tie-mcp");
        if candidate.join("src").join("server.js").is_file() {
            results.push(candidate);
            break;
        }
        if !dir.pop() {
            break;
        }
    }
    results
}

fn candidate_mcp_sources(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    // User override takes priority
    if let Some(path) = mcp_source_override_path(app) {
        candidates.push(path);
    }

    if let Ok(resource) = app.path().resource_dir() {
        // Current packaging maps to $RESOURCE/tie-mcp
        candidates.push(resource.join("tie-mcp"));
        // Older releases used ../packages/tie-mcp → $RESOURCE/_up_/packages/tie-mcp
        candidates.push(resource.join("_up_").join("packages").join("tie-mcp"));
        candidates.push(resource.join("packages").join("tie-mcp"));
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest_dir.join("..").join("packages").join("tie-mcp"));
    // Ancestor scan from CARGO_MANIFEST_DIR
    candidates.extend(ancestors_scan(&manifest_dir));

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("packages").join("tie-mcp"));
        candidates.extend(ancestors_scan(&cwd));
    }

    candidates
}

fn resolve_mcp_package_source(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = mcp_source_override_path(app) {
        return Ok(path);
    }
    let candidates = candidate_mcp_sources(app);
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for candidate in &candidates {
        // override already handled; skip duplicates that are the override path
        let server = candidate.join("src").join("server.js");
        if !server.is_file() {
            continue;
        }
        let stamp = [
            candidate.join("src").join("server.js"),
            candidate.join("src").join("files.js"),
            candidate.join("SKILL.md"),
            candidate.join("package.json"),
        ]
        .into_iter()
        .filter_map(|path| fs::metadata(path).ok()?.modified().ok())
        .max()
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        match &best {
            Some((best_time, _)) if stamp <= *best_time => {}
            _ => best = Some((stamp, candidate.clone())),
        }
    }
    if let Some((_, path)) = best {
        return Ok(path);
    }
    let tried: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
    Err(format!(
        "找不到 tie-mcp 包。已尝试路径：{}。请确认仓库含 packages/tie-mcp，或重新安装应用。",
        tried.join(" ; ")
    ))
}

fn validate_workspace(path: &Path) -> Result<PathBuf, String> {
    let root = path_for_external_config(
        &path
            .canonicalize()
            .unwrap_or_else(|_| path.to_path_buf()),
    );
    let pages = root.join("pages");
    if !pages.is_dir() {
        return Err(format!(
            "工作区无效：未找到 pages 目录（{}）。请选择本地/SMB 存储源对应的目录。",
            pages.display()
        ));
    }
    Ok(root)
}

fn client_status(app: &AppHandle, client: AgentClient) -> Result<AgentClientStatus, String> {
    let config_path = config_path_for(app, client)?;
    let stale = "配置仍是用 node 启动 server.js。请更新接入：有后台地址时改为 HTTP，否则去掉该项并用本机 tie CLI。";
    let (configured, workspace_path, error) = if config_path.is_file() {
        let content = fs::read_to_string(&config_path).unwrap_or_default();
        let url = match client {
            AgentClient::Codex => parse_mcp_url_toml(&content),
            AgentClient::Cursor | AgentClient::Claude => parse_mcp_url_json(&content),
        };
        let uses_command = match client {
            AgentClient::Codex => tie_entry_uses_command_toml(&content),
            AgentClient::Cursor | AgentClient::Claude => tie_entry_uses_command_json(&content),
        };
        let local_mcp = match client {
            AgentClient::Codex => tie_entry_is_local_mcp_toml(&content),
            AgentClient::Cursor | AgentClient::Claude => tie_entry_is_local_mcp_json(&content),
        };
        let workspace = match client {
            AgentClient::Codex => parse_configured_workspace_toml(&content),
            AgentClient::Cursor | AgentClient::Claude => parse_configured_workspace_json(&content),
        };
        if url.is_some() && !uses_command {
            (true, workspace, None)
        } else if local_mcp {
            (true, workspace, None)
        } else if uses_command {
            (false, workspace, Some(stale.into()))
        } else {
            (false, None, None)
        }
    } else {
        (false, None, None)
    };

    Ok(AgentClientStatus {
        id: client.id().to_owned(),
        label: client.label().to_owned(),
        configured,
        workspace_path,
        config_path: config_path.to_string_lossy().into_owned(),
        error,
    })
}

fn status_for(app: &AppHandle) -> Result<AgentMcpStatus, String> {
    let node = node_available();
    let server = installed_mcp_dir(app)
        .ok()
        .map(|dir| dir.join("src").join("server.js"))
        .filter(|path| path.is_file());
    let cli = resolve_tie_cli_binary(Some(app));
    let mcp_ready = cli.is_some();
    let mcp_error = if cli.is_some() {
        None
    } else {
        Some("未找到 tie CLI".into())
    };

    let mut clients = Vec::new();
    for client in AgentClient::all() {
        clients.push(client_status(app, client)?);
    }

    Ok(AgentMcpStatus {
        node_available: node,
        mcp_ready,
        server_path: server.map(|path| path.to_string_lossy().into_owned()),
        mcp_error,
        clients,
    })
}

fn to_codex_status(status: AgentMcpStatus) -> CodexMcpStatus {
    let codex = status.clients.iter().find(|item| item.id == "codex");
    CodexMcpStatus {
        configured: codex.map(|item| item.configured).unwrap_or(false),
        workspace_path: codex.and_then(|item| item.workspace_path.clone()),
        server_path: status.server_path,
        config_path: codex
            .map(|item| item.config_path.clone())
            .unwrap_or_default(),
        node_available: status.node_available,
    }
}

fn parse_clients(clients: &[String]) -> Result<Vec<AgentClient>, String> {
    if clients.is_empty() {
        return Err("请至少选择一个客户端（Codex / Cursor / Claude Code）。".into());
    }
    let mut selected = Vec::new();
    for raw in clients {
        let Some(client) = AgentClient::parse(raw) else {
            return Err(format!("未知客户端：{raw}"));
        };
        if !selected.contains(&client) {
            selected.push(client);
        }
    }
    Ok(selected)
}

fn skill_sync_roots(app: &AppHandle, clients: &[AgentClient]) -> Result<Vec<PathBuf>, String> {
    let home = home_dir(app)?;
    let mut roots = vec![home.join(".agents").join("skills")];
    for client in clients {
        let extra = match client {
            AgentClient::Codex => None,
            AgentClient::Claude => Some(home.join(".claude").join("skills")),
            AgentClient::Cursor => Some(home.join(".cursor").join("skills")),
        };
        if let Some(path) = extra {
            if !roots.iter().any(|item| item == &path) {
                roots.push(path);
            }
        }
    }
    Ok(roots)
}

fn link_or_copy_skill(skill_dir: &Path, target: &Path) -> Result<(), String> {
    if target.exists() || target.is_symlink() {
        let existing = target.join("SKILL.md");
        let source = skill_dir.join("SKILL.md");
        if existing.is_file() && source.is_file() {
            #[cfg(unix)]
            {
                // 符号链接指向工作区真相源：工作区 SKILL 更新后自动生效。
                if target.is_symlink() {
                    return Ok(());
                }
            }
            // 实体目录：强制覆盖 SKILL.md，保证 Agent 侧与工作区一致。
            fs::copy(&source, &existing).map_err(|error| error.to_string())?;
            return Ok(());
        }
        return Ok(());
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(skill_dir, target).map_err(|error| {
            format!(
                "无法创建技能链接（{} → {}）：{error}",
                skill_dir.display(),
                target.display()
            )
        })?;
        return Ok(());
    }

    #[cfg(not(unix))]
    {
        fs::create_dir_all(target).map_err(|error| error.to_string())?;
        let source = skill_dir.join("SKILL.md");
        if source.is_file() {
            fs::copy(&source, target.join("SKILL.md")).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

fn packaged_tie_skill_path(app: &AppHandle) -> Option<PathBuf> {
    let candidates = [
        resolve_mcp_package_source(app)
            .ok()
            .map(|root| root.join("SKILL.md")),
        installed_mcp_dir(app)
            .ok()
            .map(|root| root.join("SKILL.md")),
    ];
    candidates.into_iter().flatten().find(|path| path.is_file())
}

fn packaged_skills_root(app: &AppHandle) -> Option<PathBuf> {
    let candidates = [
        resolve_mcp_package_source(app)
            .ok()
            .map(|root| root.join("skills")),
        installed_mcp_dir(app)
            .ok()
            .map(|root| root.join("skills")),
    ];
    candidates.into_iter().flatten().find(|path| path.is_dir())
}

fn copy_skill_template_if_changed(source: &Path, dest_dir: &Path) -> Result<bool, String> {
    let dest = dest_dir.join("SKILL.md");
    if !source.is_file() {
        return Ok(false);
    }
    let source_hash = hash_file(source);
    let dest_hash = if dest.is_file() { hash_file(&dest) } else { None };
    if source_hash.is_some() && source_hash == dest_hash {
        return Ok(false);
    }
    fs::create_dir_all(dest_dir).map_err(|error| error.to_string())?;
    fs::copy(source, &dest).map_err(|error| {
        format!(
            "无法写入 Skill（{} → {}）：{error}",
            source.display(),
            dest.display()
        )
    })?;
    Ok(true)
}

/// 用安装包 / 仓库模板覆盖工作区 `tie-memory` Skill（内容不同才写盘）。
fn ensure_workspace_tie_skill(app: &AppHandle, workspace: &Path) -> Result<bool, String> {
    let dest_dir = workspace
        .join(".agents")
        .join("skills")
        .join("tie-memory");
    let Some(source) = packaged_tie_skill_path(app) else {
        return Ok(false);
    };
    copy_skill_template_if_changed(&source, &dest_dir)
}

/// 覆盖打包进安装包的额外 Skill（如版本化 `tie-update`）。有模板才写入；不删用户自建 Skill。
fn ensure_workspace_extra_packaged_skills(
    app: &AppHandle,
    workspace: &Path,
) -> Result<Vec<String>, String> {
    let Some(skills_root) = packaged_skills_root(app) else {
        return Ok(Vec::new());
    };
    let mut updated = Vec::new();
    for entry in fs::read_dir(&skills_root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map(|item| item.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy().to_string();
        if name_str == "tie-memory" {
            continue;
        }
        let source = entry.path().join("SKILL.md");
        let dest_dir = workspace.join(".agents").join("skills").join(&name);
        if copy_skill_template_if_changed(&source, &dest_dir)? {
            updated.push(name_str);
        }
    }
    Ok(updated)
}

fn ensure_workspace_packaged_skills(app: &AppHandle, workspace: &Path) -> Result<Vec<String>, String> {
    let mut updated = Vec::new();
    if ensure_workspace_tie_skill(app, workspace)? {
        updated.push("tie-memory".into());
    }
    updated.extend(ensure_workspace_extra_packaged_skills(app, workspace)?);
    Ok(updated)
}

fn sync_workspace_skills(
    app: &AppHandle,
    workspace: &Path,
    clients: &[AgentClient],
) -> Result<(), String> {
    let skills_root = workspace.join(".agents").join("skills");
    if !skills_root.is_dir() {
        return Ok(());
    }
    let roots = skill_sync_roots(app, clients)?;
    let mut errors = Vec::new();
    for entry in fs::read_dir(&skills_root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map(|item| item.is_dir()).unwrap_or(false) {
            continue;
        }
        let skill_dir = entry.path();
        if !skill_dir.join("SKILL.md").is_file() {
            continue;
        }
        let name = entry.file_name();
        for root in &roots {
            let target = root.join(&name);
            if let Err(error) = link_or_copy_skill(&skill_dir, &target) {
                errors.push(format!("{} → {}: {error}", skill_dir.display(), target.display()));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("Skill 同步失败：{}", errors.join("; ")))
    }
}

fn configure_for_clients(
    app: &AppHandle,
    workspace_path: &str,
    clients: &[String],
    mcp_url: Option<&str>,
) -> Result<AgentMcpStatus, String> {
    let selected = parse_clients(clients)?;
    let workspace = validate_workspace(Path::new(workspace_path.trim()))?;
    let mcp_url = match mcp_url.map(str::trim).filter(|url| !url.is_empty()) {
        Some(url) => Some(normalize_mcp_url(url)?),
        None => None,
    };
    let cli_command = if mcp_url.is_none() {
        let cli = resolve_tie_cli_binary(Some(app)).ok_or_else(|| "未找到 tie CLI，无法提供本地 MCP".to_owned())?;
        Some(path_for_external_config(&cli).to_string_lossy().into_owned())
    } else {
        None
    };

    for client in &selected {
        let actor = change_actor_label(client.label());
        let launch = match mcp_url.as_deref() {
            Some(url) => TieMcpLaunch::Http(url),
            None => TieMcpLaunch::Local {
                command: cli_command.as_deref().unwrap_or(""),
                workspace: &workspace,
                actor: &actor,
            },
        };
        match client {
            AgentClient::Codex => write_codex_config(app, launch)?,
            AgentClient::Cursor => upsert_json_mcp_config(&cursor_config_path(app)?, launch, false)?,
            AgentClient::Claude => upsert_json_mcp_config(&claude_config_path(app)?, launch, true)?,
        }
    }

    ensure_workspace_packaged_skills(app, &workspace)?;
    sync_workspace_skills(app, &workspace, &selected)?;
    status_for(app)
}

#[tauri::command]
pub fn locate_tie_cli(app: AppHandle) -> Option<String> {
    resolve_tie_cli_binary(Some(&app)).map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn agent_mcp_status(app: AppHandle) -> Result<AgentMcpStatus, String> {
    status_for(&app)
}

#[tauri::command]
pub fn configure_agent_mcp(
    app: AppHandle,
    workspace_path: String,
    clients: Vec<String>,
    mcp_url: Option<String>,
) -> Result<AgentMcpStatus, String> {
    configure_for_clients(&app, &workspace_path, &clients, mcp_url.as_deref())
}

#[tauri::command]
pub fn codex_mcp_status(app: AppHandle) -> Result<CodexMcpStatus, String> {
    Ok(to_codex_status(status_for(&app)?))
}

#[tauri::command]
pub fn configure_codex_mcp(
    app: AppHandle,
    workspace_path: String,
) -> Result<CodexMcpStatus, String> {
    Ok(to_codex_status(configure_for_clients(
        &app,
        &workspace_path,
        &["codex".to_owned()],
        None,
    )?))
}

#[tauri::command]
pub fn set_mcp_source_path(app: AppHandle, path: String) -> Result<AgentMcpStatus, String> {
    let p = PathBuf::from(path.trim());
    if !p.join("src").join("server.js").is_file() {
        return Err(format!(
            "所选路径无效：未找到 {}/src/server.js",
            p.display()
        ));
    }
    save_mcp_source_override(&app, &p)?;
    status_for(&app)
}

fn chrono_like_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}
