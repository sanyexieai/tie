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

fn escape_toml_key(key: &str) -> String {
    if key
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        key.to_owned()
    } else {
        escape_toml_string(key)
    }
}

/// Windows `canonicalize` 会产出 `\\?\C:\...`；Node / Codex 环境变量里常认不了，写入外部配置前去掉。
fn strip_windows_extended_prefix(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    #[cfg(windows)]
    {
        let text = raw.as_ref();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            if let Some(unc) = rest.strip_prefix(r"UNC\") {
                return PathBuf::from(format!(r"\\{unc}"));
            }
            return PathBuf::from(rest);
        }
        if let Some(rest) = text.strip_prefix("//?/") {
            if let Some(unc) = rest.strip_prefix("UNC/") {
                return PathBuf::from(format!(r"\\{unc}"));
            }
            return PathBuf::from(rest);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = &raw;
    }
    path.to_path_buf()
}

fn path_for_external_config(path: &Path) -> PathBuf {
    strip_windows_extended_prefix(path)
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

fn parse_server_path_toml(config: &str) -> Option<String> {
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
        if in_server && trimmed.starts_with("args") {
            let (_, raw) = trimmed.split_once('=')?;
            let args: Vec<String> = serde_json::from_str(raw.trim()).ok()?;
            return args.first().cloned();
        }
    }
    None
}

fn parse_server_path_json(config: &str) -> Option<String> {
    serde_json::from_str::<Value>(config)
        .ok()?
        .get("mcpServers")?
        .get(SERVER_NAME)?
        .get("args")?
        .as_array()?
        .first()?
        .as_str()
        .map(str::to_owned)
}

fn codex_approval_configured(config: &str) -> bool {
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
        if in_server && trimmed.starts_with("default_tools_approval_mode") {
            return trimmed
                .split_once('=')
                .map(|(_, value)| value.trim().trim_matches('"') == "approve")
                .unwrap_or(false);
        }
    }
    false
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

fn mcp_package_cwd(server_path: &Path) -> Option<PathBuf> {
    // .../tie-mcp/src/server.js → .../tie-mcp
    server_path
        .parent()
        .and_then(|src| src.parent())
        .map(|path| path.to_path_buf())
        .filter(|path| path.is_dir())
}

fn build_mcp_block(server_path: &Path, workspace_path: &Path) -> String {
    let server_path = path_for_external_config(server_path);
    let workspace_path = path_for_external_config(workspace_path);
    let node = node_bin()
        .map(|path| path_for_external_config(&path).to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "node.exe".to_owned()
            } else {
                "node".to_owned()
            }
        });
    let mut block = format!(
        "[mcp_servers.tie]\ncommand = {}\nargs = [{}]\ndefault_tools_approval_mode = \"approve\"\nstartup_timeout_sec = 60\nenabled = true\n",
        escape_toml_string(&node),
        escape_toml_string(&server_path.to_string_lossy()),
    );
    if let Some(cwd) = mcp_package_cwd(&server_path) {
        block.push_str(&format!(
            "cwd = {}\n",
            escape_toml_string(&path_for_external_config(&cwd).to_string_lossy())
        ));
    }
    block.push_str("\n[mcp_servers.tie.env]\n");
    for (key, value) in mcp_runtime_env(&workspace_path) {
        block.push_str(&format!(
            "{} = {}\n",
            escape_toml_key(&key),
            escape_toml_string(&value)
        ));
    }
    block
}

fn mcp_runtime_env(workspace_path: &Path) -> Vec<(String, String)> {
    let workspace = path_for_external_config(workspace_path);
    let mut env = vec![(
        "TIE_WORKSPACE".to_owned(),
        workspace.to_string_lossy().into_owned(),
    )];

    // Windows 上 Codex 给 MCP 子进程的环境极精简，缺 PATH/SYSTEMROOT 时 node 经常起不来
    #[cfg(windows)]
    {
        env.push(("PATH".into(), command_path_env()));
        let push_env = |env: &mut Vec<(String, String)>, key: &str| {
            if let Ok(value) = std::env::var(key) {
                if !value.is_empty() {
                    env.push((key.to_owned(), value));
                }
            }
        };
        for key in [
            "SystemRoot",
            "SYSTEMROOT",
            "windir",
            "WINDIR",
            "ComSpec",
            "COMSPEC",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "APPDATA",
            "LOCALAPPDATA",
            "ProgramData",
            "PROGRAMDATA",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "TEMP",
            "TMP",
            "PATHEXT",
            "USERNAME",
            "USERDOMAIN",
            "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE",
        ] {
            push_env(&mut env, key);
        }
        // 兜底：即使当前进程缺这些变量，也写入常见默认值
        let defaults = [
            ("SystemRoot", r"C:\Windows"),
            ("SYSTEMROOT", r"C:\Windows"),
            ("windir", r"C:\Windows"),
            ("WINDIR", r"C:\Windows"),
            ("ComSpec", r"C:\Windows\System32\cmd.exe"),
            ("COMSPEC", r"C:\Windows\System32\cmd.exe"),
            ("PATHEXT", ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"),
        ];
        for (key, value) in defaults {
            if !env.iter().any(|(existing, _)| existing.eq_ignore_ascii_case(key)) {
                env.push((key.to_owned(), value.to_owned()));
            }
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            if !env.iter().any(|(k, _)| k == "APPDATA") {
                env.push((
                    "APPDATA".into(),
                    format!(r"{profile}\AppData\Roaming"),
                ));
            }
            if !env.iter().any(|(k, _)| k == "LOCALAPPDATA") {
                env.push((
                    "LOCALAPPDATA".into(),
                    format!(r"{profile}\AppData\Local"),
                ));
            }
            if !env.iter().any(|(k, _)| k == "TEMP") {
                env.push(("TEMP".into(), format!(r"{profile}\AppData\Local\Temp")));
            }
            if !env.iter().any(|(k, _)| k == "TMP") {
                env.push(("TMP".into(), format!(r"{profile}\AppData\Local\Temp")));
            }
        }
    }

    #[cfg(not(windows))]
    {
        env.push(("PATH".into(), command_path_env()));
    }

    env
}

fn mcp_server_json(server_path: &Path, workspace_path: &Path, with_type: bool) -> Value {
    let server_path = path_for_external_config(server_path);
    let workspace_path = path_for_external_config(workspace_path);
    let mut entry = Map::new();
    if with_type {
        entry.insert("type".into(), json!("stdio"));
    }
    let node = node_bin()
        .map(|path| path_for_external_config(&path).to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "node.exe".to_owned()
            } else {
                "node".to_owned()
            }
        });
    entry.insert("command".into(), json!(node));
    entry.insert(
        "args".into(),
        json!([server_path.to_string_lossy().to_string()]),
    );
    entry.insert("startup_timeout_sec".into(), json!(60));
    entry.insert("enabled".into(), json!(true));
    if let Some(cwd) = mcp_package_cwd(&server_path) {
        entry.insert(
            "cwd".into(),
            json!(path_for_external_config(&cwd).to_string_lossy().to_string()),
        );
    }
    let mut env_map = Map::new();
    for (key, value) in mcp_runtime_env(&workspace_path) {
        env_map.insert(key, json!(value));
    }
    entry.insert("env".into(), Value::Object(env_map));
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

fn write_codex_config(app: &AppHandle, server_path: &Path, workspace: &Path) -> Result<(), String> {
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
    let block = build_mcp_block(server_path, workspace);
    let next = if cleaned.is_empty() {
        block
    } else {
        format!("{}\n\n{}", cleaned, block)
    };
    fs::write(&config_path, format!("{}\n", next.trim_end())).map_err(|error| error.to_string())
}

fn upsert_json_mcp_config(
    config_path: &Path,
    server_path: &Path,
    workspace: &Path,
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

    servers.as_object_mut().unwrap().insert(
        SERVER_NAME.to_owned(),
        mcp_server_json(server_path, workspace, with_type),
    );

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
    let candidates = candidate_mcp_sources(app);
    for candidate in &candidates {
        let server = candidate.join("src").join("server.js");
        if server.is_file() {
            return Ok(candidate.clone());
        }
    }
    let tried: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
    Err(format!(
        "找不到 tie-mcp 包。已尝试路径：{}。请确认仓库含 packages/tie-mcp，或重新安装应用。",
        tried.join(" ; ")
    ))
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
    let needs_copy = !target_server.is_file()
        || fs::metadata(&source.join("src").join("server.js"))
            .ok()
            .and_then(|meta| meta.modified().ok())
            > fs::metadata(&target_server)
                .ok()
                .and_then(|meta| meta.modified().ok());

    if needs_copy {
        copy_dir_recursive(&source, &target)?;
    }

    ensure_mcp_dependencies(&source, &target)?;

    if !target_server.is_file() {
        return Err(format!("MCP 入口不存在：{}", target_server.display()));
    }
    Ok(path_for_external_config(&target_server))
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

fn client_status(
    app: &AppHandle,
    client: AgentClient,
    node: bool,
) -> Result<AgentClientStatus, String> {
    let config_path = config_path_for(app, client)?;
    let (configured, workspace_path, error) = if config_path.is_file() {
        let content = fs::read_to_string(&config_path).unwrap_or_default();
        let workspace = match client {
            AgentClient::Codex => parse_configured_workspace_toml(&content),
            AgentClient::Cursor | AgentClient::Claude => parse_configured_workspace_json(&content),
        };
        let server_path = match client {
            AgentClient::Codex => parse_server_path_toml(&content),
            AgentClient::Cursor | AgentClient::Claude => parse_server_path_json(&content),
        };
        let error = if !node {
            Some("未检测到 Node.js".into())
        } else if workspace.is_none() {
            Some("配置中缺少 TIE_WORKSPACE".into())
        } else if !workspace
            .as_ref()
            .map(|path| Path::new(path).join("pages").is_dir())
            .unwrap_or(false)
        {
            Some("配置的 Tie 工作区无效".into())
        } else if !server_path
            .as_ref()
            .map(|path| Path::new(path).is_file())
            .unwrap_or(false)
        {
            Some("配置的 tie-mcp 服务入口不存在".into())
        } else if client == AgentClient::Codex && !codex_approval_configured(&content) {
            Some("Codex 配置缺少 MCP 工具审批策略".into())
        } else {
            None
        };
        (error.is_none(), workspace, error)
    } else {
        (false, None, Some("尚未写入客户端配置".into()))
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

    let source_ok = resolve_mcp_package_source(app).is_ok();
    let mcp_ready = node && (server.is_some() || source_ok);
    let mcp_error = if !node {
        Some("未检测到 Node.js".into())
    } else if !source_ok && server.is_none() {
        Some(resolve_mcp_package_source(app).unwrap_err())
    } else {
        None
    };

    let mut clients = Vec::new();
    for client in AgentClient::all() {
        clients.push(client_status(app, client, node)?);
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
                if target.is_symlink() {
                    return Ok(());
                }
            }
            let _ = fs::copy(&source, &existing);
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

fn ensure_workspace_tie_skill(app: &AppHandle, workspace: &Path) -> Result<(), String> {
    let dest_dir = workspace
        .join(".agents")
        .join("skills")
        .join("tie-memory");
    let dest = dest_dir.join("SKILL.md");
    if dest.is_file() {
        return Ok(());
    }

    let candidates = [
        resolve_mcp_package_source(app)
            .ok()
            .map(|root| root.join("SKILL.md")),
        installed_mcp_dir(app)
            .ok()
            .map(|root| root.join("SKILL.md")),
    ];
    let Some(source) = candidates
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
    else {
        return Ok(());
    };

    fs::create_dir_all(&dest_dir).map_err(|error| error.to_string())?;
    fs::copy(&source, &dest).map_err(|error| {
        format!(
            "无法写入默认 Skill（{} → {}）：{error}",
            source.display(),
            dest.display()
        )
    })?;
    Ok(())
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
) -> Result<AgentMcpStatus, String> {
    let selected = parse_clients(clients)?;
    let workspace = validate_workspace(Path::new(workspace_path.trim()))?;
    let server_path = ensure_mcp_runtime(app)?;

    for client in &selected {
        match client {
            AgentClient::Codex => write_codex_config(app, &server_path, &workspace)?,
            AgentClient::Cursor => {
                upsert_json_mcp_config(&cursor_config_path(app)?, &server_path, &workspace, false)?
            }
            AgentClient::Claude => {
                upsert_json_mcp_config(&claude_config_path(app)?, &server_path, &workspace, true)?
            }
        }
    }

    ensure_workspace_tie_skill(app, &workspace)?;
    sync_workspace_skills(app, &workspace, &selected)?;
    status_for(app)
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
) -> Result<AgentMcpStatus, String> {
    configure_for_clients(&app, &workspace_path, &clients)
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
