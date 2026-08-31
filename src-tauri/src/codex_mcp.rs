use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

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

fn parse_configured_workspace(config: &str) -> Option<String> {
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
        "[mcp_servers.tie]\ncommand = \"node\"\nargs = [{}]\n\n[mcp_servers.tie.env]\nTIE_WORKSPACE = {}\n",
        escape_toml_string(&server_path.to_string_lossy()),
        escape_toml_string(&workspace_path.to_string_lossy())
    )
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

fn candidate_mcp_sources(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("tie-mcp"));
        candidates.push(resource.join("packages").join("tie-mcp"));
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest_dir.join("..").join("packages").join("tie-mcp"));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("packages").join("tie-mcp"));
    }
    candidates
}

fn resolve_mcp_package_source(app: &AppHandle) -> Result<PathBuf, String> {
    for candidate in candidate_mcp_sources(app) {
        let server = candidate.join("src").join("server.js");
        if server.is_file() {
            return Ok(candidate);
        }
    }
    Err("找不到 tie-mcp 包。请确认仓库含 packages/tie-mcp，或重新安装应用。".into())
}

fn ensure_mcp_runtime(app: &AppHandle) -> Result<PathBuf, String> {
    if !node_available() {
        return Err("未检测到 Node.js。接入 Codex MCP 需要本机已安装 node，并在 PATH 中可用。".into());
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
    let root = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf());
    let pages = root.join("pages");
    if !pages.is_dir() {
        return Err(format!(
            "工作区无效：未找到 pages 目录（{}）。请选择本地/SMB 存储源对应的目录。",
            pages.display()
        ));
    }
    Ok(root)
}

fn status_for(app: &AppHandle) -> Result<CodexMcpStatus, String> {
    let config_path = codex_config_path(app)?;
    let server = installed_mcp_dir(app)
        .ok()
        .map(|dir| dir.join("src").join("server.js"))
        .filter(|path| path.is_file());

    let (configured, workspace_path) = if config_path.is_file() {
        let content = fs::read_to_string(&config_path).unwrap_or_default();
        let workspace = parse_configured_workspace(&content);
        (workspace.is_some(), workspace)
    } else {
        (false, None)
    };

    Ok(CodexMcpStatus {
        configured,
        workspace_path,
        server_path: server.map(|path| path.to_string_lossy().into_owned()),
        config_path: config_path.to_string_lossy().into_owned(),
        node_available: node_available(),
    })
}

#[tauri::command]
pub fn codex_mcp_status(app: AppHandle) -> Result<CodexMcpStatus, String> {
    status_for(&app)
}

#[tauri::command]
pub fn configure_codex_mcp(app: AppHandle, workspace_path: String) -> Result<CodexMcpStatus, String> {
    let workspace = validate_workspace(Path::new(workspace_path.trim()))?;
    let server_path = ensure_mcp_runtime(&app)?;

    let config_path = codex_config_path(&app)?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let existing = if config_path.is_file() {
        fs::read_to_string(&config_path).map_err(|error| error.to_string())?
    } else {
        String::new()
    };

    if config_path.is_file() {
        let stamp = chrono_like_stamp();
        let backup = config_path.with_file_name(format!("config.toml.bak-tie-{stamp}"));
        let _ = fs::copy(&config_path, backup);
    }

    let cleaned = strip_mcp_server_block(&existing);
    let block = build_mcp_block(&server_path, &workspace);
    let next = if cleaned.is_empty() {
        block
    } else {
        format!("{}\n\n{}", cleaned, block)
    };
    fs::write(&config_path, format!("{}\n", next.trim_end())).map_err(|error| error.to_string())?;

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
