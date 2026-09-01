use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillConnection {
    pub id: String,
    pub name: String,
    /// Absolute path to SKILL.md (source of truth; never deleted by disconnect).
    pub skill_path: String,
    /// If Tie created `~/.agents/skills/<name>` for Codex, this is that directory path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_link_path: Option<String>,
    pub linked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillRegistry {
    #[serde(default)]
    pub connections: Vec<SkillConnection>,
    #[serde(default)]
    pub extra_scan_roots: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedSkill {
    pub name: String,
    pub description: String,
    pub skill_path: String,
    pub root_path: String,
    pub connected: bool,
    pub connection_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    pub name: String,
    pub description: String,
    pub path: String,
    pub content: String,
    pub connection_id: Option<String>,
}

fn home_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .home_dir()
        .map_err(|error| format!("无法定位用户主目录：{error}"))
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("skill-connections.json"))
}

fn user_skills_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(home_dir(app)?.join(".agents").join("skills"))
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn new_id() -> String {
    format!("sk_{}", &now_iso())
}

fn load_registry(app: &AppHandle) -> Result<SkillRegistry, String> {
    let path = registry_path(app)?;
    if !path.is_file() {
        return Ok(SkillRegistry::default());
    }
    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| format!("Skill 连接配置损坏：{error}"))
}

fn save_registry(app: &AppHandle, registry: &SkillRegistry) -> Result<(), String> {
    let path = registry_path(app)?;
    let raw = serde_json::to_string_pretty(registry).map_err(|error| error.to_string())?;
    fs::write(&path, format!("{raw}\n")).map_err(|error| error.to_string())
}

fn canonicalize_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn parse_skill_description(content: &str) -> String {
    let mut saw_start = false;
    let mut in_frontmatter = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if !saw_start {
            if trimmed == "---" {
                saw_start = true;
                in_frontmatter = true;
            }
            continue;
        }
        if in_frontmatter && trimmed == "---" {
            break;
        }
        if in_frontmatter && trimmed.starts_with("description:") {
            let rest = trimmed.trim_start_matches("description:").trim();
            if rest == ">|" || rest == ">-" || rest == "|" || rest.is_empty() {
                let mut parts = Vec::new();
                let mut collecting = false;
                for block_line in content
                    .lines()
                    .skip_while(|item| !item.trim().starts_with("description:"))
                {
                    let text = block_line.trim_end();
                    if !collecting {
                        collecting = true;
                        continue;
                    }
                    if text.trim().is_empty() {
                        break;
                    }
                    if !(text.starts_with(' ') || text.starts_with('\t')) {
                        break;
                    }
                    parts.push(text.trim());
                }
                return parts.join(" ");
            }
            return rest.trim_matches('"').trim_matches('\'').to_owned();
        }
    }
    String::new()
}

fn parse_skill_name_from_content(content: &str, fallback: &str) -> String {
    let mut saw_start = false;
    let mut in_frontmatter = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if !saw_start {
            if trimmed == "---" {
                saw_start = true;
                in_frontmatter = true;
            }
            continue;
        }
        if in_frontmatter && trimmed == "---" {
            break;
        }
        if in_frontmatter && trimmed.starts_with("name:") {
            let rest = trimmed
                .trim_start_matches("name:")
                .trim()
                .trim_matches('"')
                .trim_matches('\'');
            if !rest.is_empty() {
                return rest.to_owned();
            }
        }
    }
    fallback.to_owned()
}

fn read_skill_at(path: &Path) -> Result<(String, String, String), String> {
    if !path.is_file() {
        return Err(format!("Skill 文件不存在：{}", path.display()));
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let folder_name = path
        .parent()
        .and_then(|parent| parent.file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "skill".into());
    let name = parse_skill_name_from_content(&content, &folder_name);
    let description = parse_skill_description(&content);
    Ok((name, description, content))
}

fn discover_skills_in_root(root: &Path) -> Vec<(String, String, PathBuf, PathBuf)> {
    let mut found = Vec::new();
    if !root.is_dir() {
        return found;
    }

    // root/SKILL.md
    let direct = root.join("SKILL.md");
    if direct.is_file() {
        if let Ok((name, description, _)) = read_skill_at(&direct) {
            found.push((name, description, canonicalize_path(&direct), canonicalize_path(root)));
        }
    }

    // root/*/SKILL.md
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill = path.join("SKILL.md");
            if !skill.is_file() {
                continue;
            }
            if let Ok((name, description, _)) = read_skill_at(&skill) {
                found.push((
                    name,
                    description,
                    canonicalize_path(&skill),
                    canonicalize_path(&path),
                ));
            }
        }
    }
    found
}

fn common_scan_roots(app: &AppHandle, workspace_hint: Option<&str>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(home) = home_dir(app) {
        roots.push(home.join(".agents").join("skills"));
        roots.push(home.join(".codex").join("skills"));
        roots.push(home.join(".claude").join("skills"));
        roots.push(home.join(".cursor").join("skills"));
        roots.push(home.join(".cursor").join("skills-cursor"));
    }
    if let Some(workspace) = workspace_hint {
        let trimmed = workspace.trim();
        if !trimmed.is_empty() {
            roots.push(PathBuf::from(trimmed).join(".agents").join("skills"));
        }
    }
    if let Ok(registry) = load_registry(app) {
        for extra in registry.extra_scan_roots {
            roots.push(PathBuf::from(extra));
        }
    }
    roots
}

fn same_path(left: &str, right: &str) -> bool {
    let left_path = canonicalize_path(Path::new(left));
    let right_path = canonicalize_path(Path::new(right));
    left_path == right_path
}

fn mirror_skill_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let home = home_dir(app)?;
    Ok(vec![
        user_skills_root(app)?,
        home.join(".claude").join("skills"),
        home.join(".cursor").join("skills"),
    ])
}

fn ensure_skill_mirror(skill_dir: &Path, skill_path: &Path, target: &Path) -> Result<(), String> {
    if canonicalize_path(skill_dir) == canonicalize_path(target) {
        return Ok(());
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    if target.exists() || target.is_symlink() {
        let existing_skill = target.join("SKILL.md");
        if existing_skill.is_file() && same_path(&existing_skill.to_string_lossy(), &skill_path.to_string_lossy()) {
            return Ok(());
        }
        // Best-effort: refresh copied SKILL.md when the folder already exists.
        if existing_skill.is_file() && skill_path.is_file() && !target.is_symlink() {
            let _ = fs::copy(skill_path, &existing_skill);
        }
        return Ok(());
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(skill_dir, target).map_err(|error| {
            format!(
                "无法创建技能符号链接（{} → {}）：{error}",
                skill_dir.display(),
                target.display()
            )
        })?;
        return Ok(());
    }

    #[cfg(not(unix))]
    {
        fs::create_dir_all(target).map_err(|error| error.to_string())?;
        let dest = target.join("SKILL.md");
        fs::copy(skill_path, &dest).map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn ensure_codex_link(app: &AppHandle, name: &str, skill_path: &Path) -> Result<Option<PathBuf>, String> {
    let skill_dir = skill_path
        .parent()
        .ok_or_else(|| "无效的 Skill 路径".to_owned())?;
    let agents_root = user_skills_root(app)?;
    let primary = agents_root.join(name);

    // Already living under ~/.agents/skills/<name>
    if canonicalize_path(skill_dir) == canonicalize_path(&primary) {
        for root in mirror_skill_roots(app)? {
            if root == agents_root {
                continue;
            }
            let _ = ensure_skill_mirror(skill_dir, skill_path, &root.join(name));
        }
        return Ok(None);
    }

    fs::create_dir_all(&agents_root).map_err(|error| error.to_string())?;

    if primary.exists() || primary.is_symlink() {
        let existing_skill = primary.join("SKILL.md");
        if !(existing_skill.is_file() && same_path(&existing_skill.to_string_lossy(), &skill_path.to_string_lossy())) {
            return Err(format!(
                "技能目录已存在且指向其他内容：{}。请先断开或改名。",
                primary.display()
            ));
        }
    } else {
        ensure_skill_mirror(skill_dir, skill_path, &primary)?;
    }

    for root in mirror_skill_roots(app)? {
        if root == agents_root {
            continue;
        }
        let _ = ensure_skill_mirror(skill_dir, skill_path, &root.join(name));
    }

    Ok(Some(primary))
}

fn remove_codex_link(path: &Path) -> Result<(), String> {
    if path.is_symlink() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if path.is_dir() {
        // Only remove if it looks like a skill dir we manage (contains SKILL.md, nothing huge).
        let skill = path.join("SKILL.md");
        if skill.is_file() {
            let _ = fs::remove_file(skill);
        }
        // Remove directory if empty-ish
        match fs::remove_dir(path) {
            Ok(()) => Ok(()),
            Err(_) => {
                // Fall back to remove_dir_all only for our shallow skill folder
                fs::remove_dir_all(path).map_err(|error| error.to_string())
            }
        }
    } else if path.is_file() {
        fs::remove_file(path).map_err(|error| error.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn list_skill_connections(app: AppHandle) -> Result<Vec<SkillConnection>, String> {
    let mut registry = load_registry(&app)?;
    registry.connections.retain(|item| Path::new(&item.skill_path).is_file());
    save_registry(&app, &registry)?;
    Ok(registry.connections)
}

#[tauri::command]
pub fn list_extra_skill_scan_roots(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(load_registry(&app)?.extra_scan_roots)
}

#[tauri::command]
pub fn list_skill_scan_roots(app: AppHandle, workspace_path: Option<String>) -> Result<Vec<String>, String> {
    let mut roots = common_scan_roots(&app, workspace_path.as_deref())
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();
    Ok(roots)
}

#[tauri::command]
pub fn add_skill_scan_root(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("路径不能为空".into());
    }
    let root = canonicalize_path(Path::new(trimmed));
    if !root.is_dir() {
        return Err(format!("不是有效目录：{}", root.display()));
    }
    let mut registry = load_registry(&app)?;
    let rendered = root.to_string_lossy().into_owned();
    if !registry.extra_scan_roots.iter().any(|item| item == &rendered) {
        registry.extra_scan_roots.push(rendered);
        save_registry(&app, &registry)?;
    }
    list_skill_scan_roots(app, None)
}

#[tauri::command]
pub fn remove_skill_scan_root(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let mut registry = load_registry(&app)?;
    registry
        .extra_scan_roots
        .retain(|item| !same_path(item, path.trim()));
    save_registry(&app, &registry)?;
    list_skill_scan_roots(app, None)
}

#[tauri::command]
pub fn scan_skills(app: AppHandle, workspace_path: Option<String>) -> Result<Vec<ScannedSkill>, String> {
    let registry = load_registry(&app)?;
    let roots = common_scan_roots(&app, workspace_path.as_deref());
    let mut by_path = std::collections::BTreeMap::<String, ScannedSkill>::new();

    for root in roots {
        for (name, description, skill_path, root_path) in discover_skills_in_root(&root) {
            let skill_path_str = skill_path.to_string_lossy().into_owned();
            let connection = registry
                .connections
                .iter()
                .find(|item| same_path(&item.skill_path, &skill_path_str));
            by_path.insert(
                skill_path_str.clone(),
                ScannedSkill {
                    name,
                    description,
                    skill_path: skill_path_str,
                    root_path: root_path.to_string_lossy().into_owned(),
                    connected: connection.is_some(),
                    connection_id: connection.map(|item| item.id.clone()),
                },
            );
        }
    }

    // Always include connected skills even if outside scan roots
    for connection in &registry.connections {
        if by_path.contains_key(&connection.skill_path) {
            continue;
        }
        if !Path::new(&connection.skill_path).is_file() {
            continue;
        }
        let description = fs::read_to_string(&connection.skill_path)
            .map(|content| parse_skill_description(&content))
            .unwrap_or_default();
        by_path.insert(
            connection.skill_path.clone(),
            ScannedSkill {
                name: connection.name.clone(),
                description,
                skill_path: connection.skill_path.clone(),
                root_path: Path::new(&connection.skill_path)
                    .parent()
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                connected: true,
                connection_id: Some(connection.id.clone()),
            },
        );
    }

    Ok(by_path.into_values().collect())
}

#[tauri::command]
pub fn connect_skill(app: AppHandle, skill_path: String) -> Result<SkillConnection, String> {
    let path = canonicalize_path(Path::new(skill_path.trim()));
    let (name, _description, _) = read_skill_at(&path)?;
    let mut registry = load_registry(&app)?;
    if let Some(existing) = registry
        .connections
        .iter()
        .find(|item| same_path(&item.skill_path, &path.to_string_lossy()))
        .cloned()
    {
        return Ok(existing);
    }
    if registry.connections.iter().any(|item| item.name == name) {
        return Err(format!("已连接同名 Skill「{name}」，请先断开后再接入。"));
    }

    let codex_link = ensure_codex_link(&app, &name, &path)?;
    let connection = SkillConnection {
        id: new_id(),
        name,
        skill_path: path.to_string_lossy().into_owned(),
        codex_link_path: codex_link.map(|path| path.to_string_lossy().into_owned()),
        linked_at: now_iso(),
    };
    registry.connections.push(connection.clone());
    registry.connections.sort_by(|a, b| a.name.cmp(&b.name));
    save_registry(&app, &registry)?;
    Ok(connection)
}

#[tauri::command]
pub fn disconnect_skill(app: AppHandle, connection_id: String) -> Result<Vec<SkillConnection>, String> {
    let mut registry = load_registry(&app)?;
    let Some(index) = registry
        .connections
        .iter()
        .position(|item| item.id == connection_id)
    else {
        return Ok(registry.connections);
    };
    let removed = registry.connections.remove(index);
    // Only remove mirrors Tie created. Never delete the original skill_path.
    let original_dir = Path::new(&removed.skill_path).parent().map(canonicalize_path);
    let mut candidates = Vec::new();
    if let Some(link) = removed.codex_link_path.as_deref() {
        candidates.push(PathBuf::from(link));
    }
    if let Ok(roots) = mirror_skill_roots(&app) {
        for root in roots {
            candidates.push(root.join(&removed.name));
        }
    }
    candidates.sort();
    candidates.dedup();
    for link_path in candidates {
        if original_dir == Some(canonicalize_path(&link_path)) {
            continue;
        }
        let _ = remove_codex_link(&link_path);
    }
    save_registry(&app, &registry)?;
    Ok(registry.connections)
}

#[tauri::command]
pub fn read_skill_file(app: AppHandle, skill_path: String) -> Result<SkillFile, String> {
    let path = canonicalize_path(Path::new(skill_path.trim()));
    let (name, description, content) = read_skill_at(&path)?;
    let registry = load_registry(&app)?;
    let connection_id = registry
        .connections
        .iter()
        .find(|item| same_path(&item.skill_path, &path.to_string_lossy()))
        .map(|item| item.id.clone());
    Ok(SkillFile {
        name,
        description,
        path: path.to_string_lossy().into_owned(),
        content,
        connection_id,
    })
}

#[tauri::command]
pub fn write_skill_file(app: AppHandle, skill_path: String, content: String) -> Result<SkillFile, String> {
    if content.trim().is_empty() {
        return Err("Skill 内容不能为空".into());
    }
    let path = canonicalize_path(Path::new(skill_path.trim()));
    if !path.is_file() {
        return Err(format!("Skill 文件不存在：{}", path.display()));
    }
    fs::write(&path, &content).map_err(|error| error.to_string())?;

    // If this connection has a copied Codex link (non-symlink), refresh the copy.
    let registry = load_registry(&app)?;
    if let Some(connection) = registry
        .connections
        .iter()
        .find(|item| same_path(&item.skill_path, &path.to_string_lossy()))
    {
        if let Some(link) = connection.codex_link_path.as_deref() {
            let link_path = Path::new(link);
            if link_path.is_dir() && !link_path.is_symlink() {
                let dest = link_path.join("SKILL.md");
                let _ = fs::copy(&path, dest);
            }
        }
    }

    read_skill_file(app, path.to_string_lossy().into_owned())
}
