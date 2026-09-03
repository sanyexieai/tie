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

fn codex_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(home_dir(app)?.join(".codex").join("config.toml"))
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

fn node_available() -> bool {
    Command::new("node")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn escape_toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
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

fn build_mcp_block(server_path: &Path, workspace_path: &Path) -> String {
    format!(
        "[mcp_servers.tie]\ncommand = \"node\"\nargs = [{}]\ndefault_tools_approval_mode = \"approve\"\n\n[mcp_servers.tie.env]\nTIE_WORKSPACE = {}\n",
        escape_toml_string(&server_path.to_string_lossy()),
        escape_toml_string(&workspace_path.to_string_lossy())
    )
}

fn mcp_server_json(server_path: &Path, workspace_path: &Path, with_type: bool) -> Value {
    let mut entry = Map::new();
    if with_type {
        entry.insert("type".into(), json!("stdio"));
    }
    entry.insert("command".into(), json!("node"));
    entry.insert(
        "args".into(),
        json!([server_path.to_string_lossy().to_string()]),
    );
    entry.insert(
        "env".into(),
        json!({ "TIE_WORKSPACE": workspace_path.to_string_lossy().to_string() }),
    );
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
        candidates.push(resource.join("tie-mcp"));
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

    let node_modules = target.join("node_modules");
    if !node_modules.is_dir() {
        let status = Command::new("npm")
            .args(["install", "--omit=dev"])
            .current_dir(&target)
            .status()
            .map_err(|error| format!("无法运行 npm install：{error}"))?;
        if !status.success() {
            return Err("npm install 失败，请检查网络与 npm 配置后重试。".into());
        }
    }

    if !target_server.is_file() {
        return Err(format!("MCP 入口不存在：{}", target_server.display()));
    }
    Ok(target_server)
}

fn validate_workspace(path: &Path) -> Result<PathBuf, String> {
    let root = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
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
            let _ = link_or_copy_skill(&skill_dir, &target);
        }
    }
    Ok(())
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

    let _ = sync_workspace_skills(app, &workspace, &selected);
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
