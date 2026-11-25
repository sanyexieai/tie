use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use tie_common::fs_path::{canonicalize, paths_equal};

pub fn markdown_path(root: &Path, page_id: &str) -> PathBuf {
    root.join("pages").join(format!("{page_id}.md"))
}

const RESERVED_STEMS: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// UTF-8 bytes were once stored as Latin-1 code points (`测试` → `æµè¯`).
/// Recover that text. Mixed strings that already contain real non-Latin characters stay as they are.
pub fn repair_utf8_mojibake(text: &str) -> String {
    if !text.chars().any(|ch| ('\u{80}'..='\u{FF}').contains(&ch)) {
        return text.to_owned();
    }
    if text.chars().any(|ch| (ch as u32) > 0xFF) {
        return text.to_owned();
    }
    let bytes: Vec<u8> = text.chars().map(|ch| ch as u8).collect();
    let Ok(decoded) = String::from_utf8(bytes) else {
        return text.to_owned();
    };
    if decoded != text && decoded.chars().any(|ch| ('\u{4E00}'..='\u{9FFF}').contains(&ch)) {
        decoded
    } else {
        text.to_owned()
    }
}

/// Turn a title into a single path segment. Empty or illegal names fall back to `fallback`.
pub fn filename_stem(raw: &str, fallback: &str) -> String {
    let repaired = repair_utf8_mojibake(raw);
    let raw = repaired.as_str();
    let mut stem = String::new();
    let mut spaced = false;
    for ch in raw.chars() {
        let illegal = matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            || ch.is_control();
        if illegal || ch.is_whitespace() {
            if !spaced && !stem.is_empty() {
                stem.push(' ');
                spaced = true;
            }
            continue;
        }
        stem.push(ch);
        spaced = false;
    }
    let trimmed = stem.trim().trim_matches('.').trim();
    let mut stem: String = trimmed.chars().take(80).collect();
    stem = stem.trim().trim_matches('.').trim().to_owned();
    if stem.is_empty() || RESERVED_STEMS.iter().any(|name| stem.eq_ignore_ascii_case(name)) {
        let fallback = fallback.trim();
        if fallback.is_empty() {
            "无标题".to_owned()
        } else {
            fallback.chars().take(80).collect()
        }
    } else {
        stem
    }
}

fn read_frontmatter_id(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut buf = [0u8; 4096];
    let n = file.read(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("id:") {
            let id = rest.trim();
            // 只认 Tie 页面 id。其他 YAML（例如 Obsidian 的 id）留在正文里。
            if id.starts_with("pg_") {
                return Some(id.to_owned());
            }
        }
    }
    None
}

pub fn find_page_file(root: &Path, page_id: &str) -> Option<PathBuf> {
    if let Some(path) = indexed_page_file(root, page_id) {
        return Some(path);
    }
    let dir = root.join("pages");
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        if read_frontmatter_id(&path).as_deref() == Some(page_id) {
            return Some(path);
        }
    }
    None
}

/// Resolve direct legacy names or a sidecar without scanning every page.
pub(crate) fn indexed_page_file(root: &Path, page_id: &str) -> Option<PathBuf> {
    let legacy = markdown_path(root, page_id);
    if legacy.is_file() && read_frontmatter_id(&legacy).as_deref() == Some(page_id) {
        return Some(legacy);
    }
    meta_page_file(root, page_id)
}

/// `pages/<标题>.md`. A second page with the same title gets `pages/<标题>-2.md`, then `-3`, and so on.
pub fn allocate_page_path(root: &Path, page_id: &str, title: &str) -> PathBuf {
    let current = find_page_file(root, page_id);
    allocate_page_path_with_current(root, page_id, title, current.as_deref())
}

pub(crate) fn allocate_page_path_with_current(
    root: &Path,
    page_id: &str,
    title: &str,
    current: Option<&Path>,
) -> PathBuf {
    let dir = root.join("pages");
    let stem = filename_stem(title, "无标题");
    for n in 0..10_000 {
        let name = if n == 0 {
            format!("{stem}.md")
        } else {
            format!("{stem}-{}.md", n + 1)
        };
        let candidate = dir.join(&name);
        let ours = current.is_some_and(|path| paths_equal(path, &candidate))
            || (candidate.is_file() && read_frontmatter_id(&candidate).as_deref() == Some(page_id));
        if !candidate.exists() || ours {
            return candidate;
        }
    }
    dir.join(format!("{page_id}.md"))
}

pub fn page_meta_path(root: &Path, page_id: &str) -> PathBuf {
    root.join(".tie").join("meta").join(page_id)
}

fn safe_meta_id(page_id: &str) -> bool {
    !page_id.is_empty()
        && page_id.len() <= 80
        && page_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn meta_page_file(root: &Path, page_id: &str) -> Option<PathBuf> {
    if !safe_meta_id(page_id) {
        return None;
    }
    let text = fs::read_to_string(page_meta_path(root, page_id)).ok()?;
    let relative = text.lines().find_map(|line| {
        let (key, value) = line.trim().split_once(':')?;
        (key.trim() == "file").then(|| value.trim().to_owned())
    })?;
    let path = resolve_workspace_file(root, &relative)?;
    path.is_file().then_some(path)
}

pub fn resolve_workspace_file(root: &Path, relative: &str) -> Option<PathBuf> {
    if relative.is_empty() || relative.contains(':') {
        return None;
    }
    let mut path = root.to_path_buf();
    for part in relative.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return None;
        }
        path.push(part);
    }
    Some(path)
}

pub fn workspace_relative(root: &Path, path: &Path) -> Result<String, String> {
    let root_abs = canonicalize(root);
    let path_abs = canonicalize(path);
    let relative = path_abs.strip_prefix(&root_abs).map_err(|_| {
        format!("页面文件不在工作区内：{}", path.display())
    })?;
    let text = relative
        .components()
        .filter(|component| !matches!(component, std::path::Component::CurDir))
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/");
    if text.is_empty() || text.split('/').any(|part| part == "..") {
        return Err("页面相对路径无效".to_owned());
    }
    Ok(text)
}

/// Point an existing sidecar at a renamed markdown file. No-op when the page has no sidecar yet.
pub fn retarget_page_meta(root: &Path, page_id: &str, relative_file: &str) -> Result<(), String> {
    if !safe_meta_id(page_id) {
        return Ok(());
    }
    let path = page_meta_path(root, page_id);
    if !path.is_file() {
        return Ok(());
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
    let mut found = false;
    for line in &mut lines {
        if line.trim_start().starts_with("file:") {
            *line = format!("file: {relative_file}");
            found = true;
        }
    }
    if !found {
        lines.insert(0, format!("file: {relative_file}"));
    }
    fs::write(&path, format!("{}\n", lines.join("\n"))).map_err(|error| error.to_string())
}

pub fn revision_dir(root: &Path, page_id: &str) -> PathBuf {
    root.join(".tie").join("history").join(page_id)
}

pub fn page_asset_dir(root: &Path, page_id: &str) -> PathBuf {
    root.join(".tie").join("assets").join(page_id)
}

pub fn sanitize_asset_name(file_name: &str) -> Result<String, String> {
    let base = Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("附件名称无效")?;
    if base.is_empty()
        || base == "."
        || base == ".."
        || !base
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '.' || character == '-' || character == '_')
    {
        return Err("附件名称无效".to_owned());
    }
    Ok(base.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_utf8_misread_as_latin1_before_naming() {
        let broken = "\u{00e6}\u{00b5}\u{008b}\u{00e8}\u{00af}\u{0095}MCP";
        assert_eq!(repair_utf8_mojibake(broken), "测试MCP");
        assert_eq!(filename_stem(broken, "无标题"), "测试MCP");
        assert_eq!(filename_stem("欢迎使用 Tie", "无标题"), "欢迎使用 Tie");
    }
}

pub fn settings_file(data_dir: &Path) -> PathBuf {
    data_dir.join("workspace.json")
}

pub fn default_workspace_root(data_dir: &Path) -> PathBuf {
    data_dir.join("workspace")
}
