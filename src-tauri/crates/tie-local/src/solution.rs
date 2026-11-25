//! Tie solution file (`.tie`) — text workspace entry, like a `.sln`.
//!
//! The solution points at a directory tree (`pages/` + `.tie/`). Content lives
//! in that tree; the `.tie` file is only the openable entry + metadata.

use crate::paths::filename_stem;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tie_common::fs_path::{canonicalize, paths_equal};

pub const SOLUTION_VERSION: u32 = 1;
pub const SOLUTION_KIND: &str = "solution";
pub const SOLUTION_EXT: &str = "tie";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TieSolution {
    pub tie_version: u32,
    pub kind: String,
    pub name: String,
    /// Workspace root relative to the solution file's directory (`"."` = same dir).
    pub root: String,
    pub source_id: String,
    /// Page id treated as the tree root. Empty means the whole workspace.
    pub root_page: String,
}

impl Default for TieSolution {
    fn default() -> Self {
        Self {
            tie_version: SOLUTION_VERSION,
            kind: SOLUTION_KIND.to_owned(),
            name: String::new(),
            root: ".".to_owned(),
            source_id: String::new(),
            root_page: String::new(),
        }
    }
}

impl TieSolution {
    pub fn new(name: impl Into<String>, source_id: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            source_id: source_id.into(),
            ..Default::default()
        }
    }

    pub fn to_text(&self) -> String {
        let name = self.name.trim();
        let root = if self.root.trim().is_empty() {
            "."
        } else {
            self.root.trim()
        };
        let source = self.source_id.trim();
        let root_page = self.root_page.trim().replace(['\r', '\n'], "");
        let mut text = format!(
            "# Tie solution — open with Tie / `tie open`\n\
             tie_version: {}\n\
             kind: {}\n\
             name: {}\n\
             root: {}\n\
             source_id: {}\n",
            self.tie_version,
            if self.kind.trim().is_empty() {
                SOLUTION_KIND
            } else {
                self.kind.trim()
            },
            name.replace(['\r', '\n'], " "),
            root,
            source,
        );
        if !root_page.is_empty() {
            text.push_str(&format!("root_page: {root_page}\n"));
        }
        text
    }
}

fn line_value<'a>(lines: &'a [&str], key: &str) -> Option<&'a str> {
    let prefix = format!("{key}:");
    for line in lines {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix(&prefix) {
            return Some(rest.trim());
        }
    }
    None
}

pub fn parse_solution_text(text: &str) -> Result<TieSolution, String> {
    let lines: Vec<&str> = text.lines().collect();
    let version_raw = line_value(&lines, "tie_version").unwrap_or("1");
    let tie_version: u32 = version_raw
        .parse()
        .map_err(|_| format!("tie_version 无效：{version_raw}"))?;
    if tie_version != SOLUTION_VERSION {
        return Err(format!(
            "不支持的 solution tie_version：{tie_version}（期望 {SOLUTION_VERSION}）"
        ));
    }
    let kind = line_value(&lines, "kind")
        .unwrap_or(SOLUTION_KIND)
        .to_owned();
    if kind != SOLUTION_KIND {
        return Err(format!("不是 Tie solution（kind={kind}）"));
    }
    Ok(TieSolution {
        tie_version,
        kind,
        name: line_value(&lines, "name").unwrap_or("").to_owned(),
        root: line_value(&lines, "root").unwrap_or(".").to_owned(),
        source_id: line_value(&lines, "source_id").unwrap_or("").to_owned(),
        root_page: line_value(&lines, "root_page").unwrap_or("").to_owned(),
    })
}

pub fn read_solution(path: &Path) -> Result<TieSolution, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("无法读取 {}: {e}", path.display()))?;
    parse_solution_text(&text)
}

pub fn write_solution(path: &Path, solution: &TieSolution) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::write(path, solution.to_text()).map_err(|e| format!("无法写入 {}: {e}", path.display()))
}

pub fn default_solution_path(workspace_root: &Path) -> PathBuf {
    let name = workspace_root
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .unwrap_or("workspace");
    workspace_root.join(format!("{name}.{SOLUTION_EXT}"))
}

pub fn solution_display_name(workspace_name: &str, source_name: &str) -> String {
    let source = source_name.trim();
    if !source.is_empty() && !source.eq_ignore_ascii_case("workspace") {
        return source.to_owned();
    }
    let workspace = workspace_name.trim();
    if !workspace.is_empty() {
        return workspace.to_owned();
    }
    "我的知识库".to_owned()
}

fn list_solution_files(root: &Path) -> Vec<(PathBuf, TieSolution)> {
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != SOLUTION_EXT {
            continue;
        }
        if let Ok(solution) = read_solution(&path) {
            found.push((path, solution));
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

pub fn find_solution_file(root: &Path) -> Option<(PathBuf, TieSolution)> {
    let mut files = list_solution_files(root);
    files.sort_by(|a, b| {
        let rank = |path: &Path| {
            let stem = path.file_stem().and_then(|n| n.to_str()).unwrap_or("");
            let suffixed = stem
                .rsplit_once('-')
                .and_then(|(_, n)| n.parse::<u32>().ok())
                .is_some();
            (if suffixed { 1 } else { 0 }, path.to_string_lossy().to_lowercase())
        };
        rank(&a.0).cmp(&rank(&b.0))
    });
    files.into_iter().next()
}

fn allocate_solution_path(root: &Path, title: &str, current: Option<&Path>) -> PathBuf {
    let fallback = root
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .unwrap_or("workspace");
    let stem = filename_stem(title, fallback);
    for n in 0..10_000 {
        let name = if n == 0 {
            format!("{stem}.{SOLUTION_EXT}")
        } else {
            format!("{stem}-{}.{SOLUTION_EXT}", n + 1)
        };
        let candidate = root.join(&name);
        let ours = current.is_some_and(|path| paths_equal(path, &candidate));
        if !candidate.exists() || ours {
            return candidate;
        }
    }
    root.join(format!("workspace.{SOLUTION_EXT}"))
}

/// Create or refresh the workspace `.tie`, named after the title.
/// A name already taken by another file becomes `<标题>-2.tie`.
pub fn ensure_solution_file(root: &Path, title: &str, source_id: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let existing = list_solution_files(root);
    let current = existing
        .iter()
        .find(|(_, solution)| solution.source_id == source_id)
        .or_else(|| if existing.len() == 1 { existing.first() } else { None });
    let display = {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            solution_display_name("", "")
        } else {
            trimmed.to_owned()
        }
    };
    let path = allocate_solution_path(root, &display, current.map(|(path, _)| path.as_path()));
    if let Some((old, _)) = current {
        if !paths_equal(old, &path) {
            fs::rename(old, &path).map_err(|e| format!("无法重命名解决方案：{e}"))?;
        }
    }
    let solution = TieSolution::new(display, source_id);
    let text = solution.to_text();
    if fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
        write_solution(&path, &solution)?;
    }
    Ok(path)
}

fn solution_is_local(solution: &TieSolution) -> bool {
    let root = solution.root.trim();
    root.is_empty() || root == "."
}

fn allocate_named_tie(
    dir: &Path,
    stem: &str,
    keep: Option<&Path>,
    reserved: &HashSet<String>,
) -> PathBuf {
    let keep_key = keep.map(solution_path_key);
    for n in 0..10_000 {
        let name = if n == 0 {
            format!("{stem}.{SOLUTION_EXT}")
        } else {
            format!("{stem}-{}.{SOLUTION_EXT}", n + 1)
        };
        let candidate = dir.join(name);
        let candidate_key = solution_path_key(&candidate);
        if reserved.contains(&candidate_key) {
            continue;
        }
        let ours = keep_key.as_ref() == Some(&candidate_key);
        if !candidate.exists() || ours {
            return candidate;
        }
    }
    dir.join(format!("workspace.{SOLUTION_EXT}"))
}

fn solution_path_key(path: &Path) -> String {
    let path = canonicalize(path);
    let text = path.to_string_lossy();
    #[cfg(windows)]
    {
        text.replace('/', "\\").to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        text.into_owned()
    }
}

#[derive(Clone, Debug)]
pub struct RootTiePage {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub is_root: bool,
}

/// One `.tie` per top-level page, named after that page. Duplicate titles get `-2`, `-3`, …
/// A workspace-level file with no `root_page` is removed once any root exists.
pub fn sync_root_tie_files(
    root: &Path,
    source_id: &str,
    pages: &[RootTiePage],
) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut roots: Vec<&RootTiePage> = pages.iter().filter(|page| page.is_root).collect();
    roots.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    if roots.is_empty() {
        if list_solution_files(root).is_empty() {
            let name = root
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("workspace");
            ensure_solution_file(root, name, source_id)?;
        }
        return Ok(());
    }

    let existing = list_solution_files(root);
    let managed: Vec<_> = existing
        .iter()
        .filter(|(_, solution)| {
            solution_is_local(solution)
                && (solution.source_id.is_empty() || solution.source_id == source_id)
        })
        .collect();

    let mut current_by_page = HashMap::new();
    for item in &managed {
        current_by_page.entry(item.1.root_page.as_str()).or_insert(item.0.as_path());
    }
    let mut reserved = HashSet::new();
    let mut assigned = Vec::new();
    for page in roots {
        let stem = filename_stem(&page.title, "无标题");
        let current = current_by_page.get(page.id.as_str()).copied();
        let path = allocate_named_tie(
            root,
            &stem,
            current,
            &reserved,
        );
        if let Some(old) = current {
            if !paths_equal(old, &path) {
                fs::rename(old, &path).map_err(|e| format!("无法重命名解决方案：{e}"))?;
            }
        }
        let mut solution = TieSolution::new(page.title.trim(), source_id);
        solution.root_page = page.id.clone();
        let text = solution.to_text();
        if fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
            write_solution(&path, &solution)?;
        }
        reserved.insert(solution_path_key(&path));
        assigned.push(path);
    }

    let assigned: HashSet<_> = assigned.iter().map(|path| solution_path_key(path)).collect();
    for (path, _) in managed {
        if assigned.contains(&solution_path_key(path)) {
            continue;
        }
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn relative_workspace_root(from_dir: &Path, workspace: &Path) -> String {
    let from_dir = canonicalize(from_dir);
    let workspace = canonicalize(workspace);
    if paths_equal(&from_dir, &workspace) {
        return ".".to_owned();
    }
    let from_comps: Vec<_> = from_dir.components().collect();
    let to_comps: Vec<_> = workspace.components().collect();
    let mut shared = 0;
    while shared < from_comps.len()
        && shared < to_comps.len()
        && from_comps[shared] == to_comps[shared]
    {
        shared += 1;
    }
    if shared == 0 {
        return workspace.display().to_string();
    }
    let mut rel = PathBuf::new();
    for _ in shared..from_comps.len() {
        rel.push("..");
    }
    for comp in &to_comps[shared..] {
        rel.push(comp);
    }
    if rel.as_os_str().is_empty() {
        ".".to_owned()
    } else {
        rel.to_string_lossy().replace('\\', "/")
    }
}

/// Write a `.tie` whose tree root is `page_id`, even when that page is not a top-level page.
pub fn write_exported_tie(
    dest: &Path,
    workspace: &Path,
    source_id: &str,
    page_id: &str,
    title: &str,
) -> Result<PathBuf, String> {
    let dest = if dest
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(SOLUTION_EXT))
    {
        dest.to_path_buf()
    } else {
        dest.with_extension(SOLUTION_EXT)
    };
    let parent = dest.parent().filter(|path| !path.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let mut solution = TieSolution::new(title.trim(), source_id);
    solution.root = relative_workspace_root(parent, workspace);
    solution.root_page = page_id.trim().to_owned();
    if solution.root_page.is_empty() {
        return Err("导出需要页面 id".to_owned());
    }
    write_solution(&dest, &solution)?;
    Ok(dest)
}

/// Resolve a CLI/app entry path into an absolute workspace root.
///
/// Accepts:
/// - a `.tie` solution file
/// - a directory containing `pages/`
pub fn resolve_workspace_entry(
    entry: &Path,
) -> Result<(PathBuf, Option<TieSolution>), String> {
    let entry = if entry.exists() {
        entry
            .canonicalize()
            .map_err(|e| format!("无法解析路径 {}：{e}", entry.display()))?
    } else {
        return Err(format!("路径不存在：{}", entry.display()));
    };

    if entry.is_file() {
        let ext = entry
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == SOLUTION_EXT {
            let solution = read_solution(&entry)?;
            let base = entry
                .parent()
                .ok_or_else(|| format!("解决方案无父目录：{}", entry.display()))?;
            let rel = if solution.root.trim().is_empty() {
                Path::new(".")
            } else {
                Path::new(solution.root.trim())
            };
            let root = base
                .join(rel)
                .canonicalize()
                .map_err(|e| format!("无法解析工作区根 {}：{e}", base.join(rel).display()))?;
            if !root.join("pages").is_dir() {
                return Err(format!(
                    "解决方案指向的工作区无效（缺少 pages/）：{}",
                    root.display()
                ));
            }
            return Ok((root, Some(solution)));
        }
        if ext == "tiez" {
            return Err(
                "请先用 `tie unpack` 解压 .tiez，再用 `tie open` 打开其中的 .tie 或目录"
                    .to_owned(),
            );
        }
        return Err(format!("无法作为工作区入口：{}", entry.display()));
    }

    if entry.is_dir() {
        if !entry.join("pages").is_dir() {
            return Err(format!("工作区无效：未找到 {}/pages", entry.display()));
        }
        let sol = find_solution_file(&entry).map(|(_, solution)| solution);
        return Ok((entry, sol));
    }

    Err(format!("无法作为工作区入口：{}", entry.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn solution_roundtrip_text() {
        let sol = TieSolution::new("Demo", "src_local_abcdef0123456789");
        let parsed = parse_solution_text(&sol.to_text()).expect("parse");
        assert_eq!(parsed.name, "Demo");
        assert_eq!(parsed.source_id, "src_local_abcdef0123456789");
        assert_eq!(parsed.root, ".");
        assert_eq!(parsed.kind, SOLUTION_KIND);
        assert!(parsed.root_page.is_empty());
        assert!(!sol.to_text().contains("root_page"));
    }

    #[test]
    fn solution_roundtrips_root_page() {
        let mut sol = TieSolution::new("子页面", "src_a");
        sol.root_page = "pg_child".into();
        let parsed = parse_solution_text(&sol.to_text()).expect("parse");
        assert_eq!(parsed.root_page, "pg_child");
        assert_eq!(parsed.name, "子页面");
    }

    #[test]
    fn sync_writes_one_tie_per_root_and_renames_with_the_title() {
        let dir = env::temp_dir().join(format!("tie-roots-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("我的知识库.tie"),
            TieSolution::new("我的知识库", "src_a").to_text(),
        )
        .unwrap();
        sync_root_tie_files(
            &dir,
            "src_a",
            &[
                RootTiePage {
                    id: "pg_a".into(),
                    title: "无标题".into(),
                    created_at: "1".into(),
                    is_root: true,
                },
                RootTiePage {
                    id: "pg_b".into(),
                    title: "无标题".into(),
                    created_at: "2".into(),
                    is_root: true,
                },
                RootTiePage {
                    id: "pg_c".into(),
                    title: "子页面".into(),
                    created_at: "3".into(),
                    is_root: false,
                },
            ],
        )
        .unwrap();
        assert!(dir.join("无标题.tie").is_file());
        assert!(dir.join("无标题-2.tie").is_file());
        assert!(!dir.join("我的知识库.tie").exists());
        assert!(!dir.join("子页面.tie").exists());
        let first = parse_solution_text(&fs::read_to_string(dir.join("无标题.tie")).unwrap()).unwrap();
        assert_eq!(first.root_page, "pg_a");

        sync_root_tie_files(
            &dir,
            "src_a",
            &[
                RootTiePage {
                    id: "pg_a".into(),
                    title: "欢迎".into(),
                    created_at: "1".into(),
                    is_root: true,
                },
                RootTiePage {
                    id: "pg_b".into(),
                    title: "无标题".into(),
                    created_at: "2".into(),
                    is_root: true,
                },
            ],
        )
        .unwrap();
        let renamed = parse_solution_text(&fs::read_to_string(dir.join("欢迎.tie")).unwrap()).unwrap();
        let kept = parse_solution_text(&fs::read_to_string(dir.join("无标题.tie")).unwrap()).unwrap();
        assert_eq!(renamed.root_page, "pg_a");
        assert_eq!(kept.root_page, "pg_b");
        assert!(!dir.join("无标题-2.tie").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn root_sync_keeps_existing_page_associations_and_unmanaged_solutions() {
        let dir = env::temp_dir().join(format!("tie-root-associations-{}", crate::new_page_id()));
        fs::create_dir_all(&dir).unwrap();
        let mut old = TieSolution::new("旧根", "src_a");
        old.root_page = "pg_a".into();
        write_solution(&dir.join("legacy.tie"), &old).unwrap();
        let foreign = TieSolution::new("分类", "src_other").to_text();
        fs::write(dir.join("分类.tie"), &foreign).unwrap();
        let mut roots = vec![
            RootTiePage { id: "pg_a".into(), title: "分类".into(), created_at: "1".into(), is_root: true },
            RootTiePage { id: "pg_b".into(), title: "分类".into(), created_at: "2".into(), is_root: true },
        ];
        sync_root_tie_files(&dir, "src_a", &roots).unwrap();
        assert_eq!(read_solution(&dir.join("分类-2.tie")).unwrap().root_page, "pg_a");
        assert_eq!(read_solution(&dir.join("分类-3.tie")).unwrap().root_page, "pg_b");
        assert!(!dir.join("legacy.tie").exists());
        assert_eq!(fs::read_to_string(dir.join("分类.tie")).unwrap(), foreign);

        roots[0].title = "重命名".into();
        sync_root_tie_files(&dir, "src_a", &roots).unwrap();
        assert_eq!(read_solution(&dir.join("重命名.tie")).unwrap().root_page, "pg_a");
        assert_eq!(read_solution(&dir.join("分类-2.tie")).unwrap().root_page, "pg_b");
        assert!(!dir.join("分类-3.tie").exists());
        assert_eq!(fs::read_to_string(dir.join("分类.tie")).unwrap(), foreign);
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn root_sync_reserves_symlink_targets_and_keeps_assigned_aliases_alive() {
        let base = env::temp_dir().join(format!("tie-root-alias-{}", crate::new_page_id()));
        let root = base.join("workspace");
        fs::create_dir_all(&root).unwrap();
        let alias = base.join("workspace-alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        let mut old = TieSolution::new("旧根", "src_a");
        old.root_page = "pg_a".into();
        write_solution(&root.join("z-old.tie"), &old).unwrap();
        std::os::unix::fs::symlink("z-old.tie", root.join("a-old.tie")).unwrap();
        let roots = vec![
            RootTiePage { id: "pg_a".into(), title: "Repeat".into(), created_at: "1".into(), is_root: true },
            RootTiePage { id: "pg_b".into(), title: "Repeat".into(), created_at: "2".into(), is_root: true },
            RootTiePage { id: "pg_c".into(), title: "z-old".into(), created_at: "3".into(), is_root: true },
        ];
        for _ in 0..2 {
            sync_root_tie_files(&alias, "src_a", &roots).unwrap();
            assert!(root.join("Repeat.tie").symlink_metadata().unwrap().file_type().is_symlink());
            assert_eq!(read_solution(&root.join("Repeat.tie")).unwrap().root_page, "pg_a");
            assert_eq!(read_solution(&root.join("Repeat-2.tie")).unwrap().root_page, "pg_b");
            assert_eq!(read_solution(&root.join("z-old-2.tie")).unwrap().root_page, "pg_c");
            assert_eq!(read_solution(&root.join("z-old.tie")).unwrap().root_page, "pg_a");
        }
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[test]
    fn root_sync_keeps_windows_case_equivalent_current_path() {
        let dir = env::temp_dir().join(format!("tie-root-case-{}", crate::new_page_id()));
        fs::create_dir_all(&dir).unwrap();
        let mut old = TieSolution::new("MixedCase", "src_a");
        old.root_page = "pg_a".into();
        write_solution(&dir.join("MixedCase.tie"), &old).unwrap();
        sync_root_tie_files(&dir.canonicalize().unwrap(), "src_a", &[
            RootTiePage { id: "pg_a".into(), title: "mixedcase".into(), created_at: "1".into(), is_root: true },
        ]).unwrap();
        assert_eq!(read_solution(&dir.join("mixedcase.tie")).unwrap().root_page, "pg_a");
        assert!(!dir.join("mixedcase-2.tie").exists());
        assert_eq!(list_solution_files(&dir).len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn exported_tie_uses_the_current_page_as_root() {
        let workspace = env::temp_dir().join(format!("tie-export-ws-{}", std::process::id()));
        let _ = fs::remove_dir_all(&workspace);
        fs::create_dir_all(workspace.join("pages")).unwrap();
        let inside = write_exported_tie(
            &workspace.join("子页面.tie"),
            &workspace,
            "src_a",
            "pg_child",
            "子页面",
        )
        .unwrap();
        let parsed = parse_solution_text(&fs::read_to_string(&inside).unwrap()).unwrap();
        assert_eq!(parsed.root, ".");
        assert_eq!(parsed.root_page, "pg_child");
        let outside_dir = env::temp_dir().join(format!("tie-export-out-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside_dir);
        let outside = write_exported_tie(
            &outside_dir.join("子页面"),
            &workspace,
            "src_a",
            "pg_child",
            "子页面",
        )
        .unwrap();
        assert_eq!(outside.extension().and_then(|ext| ext.to_str()), Some("tie"));
        let outside_text = fs::read_to_string(&outside).unwrap();
        assert!(outside_text.contains("root_page: pg_child"));
        assert!(!outside_text.contains("\nroot: .\n"));
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&outside_dir);
    }

    #[test]
    fn resolve_from_solution_file() {
        let dir = env::temp_dir().join(format!("tie-sol-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("pages")).unwrap();
        let sol_path = dir.join("demo.tie");
        write_solution(&sol_path, &TieSolution::new("demo", "src_local_x")).unwrap();
        let (root, sol) = resolve_workspace_entry(&sol_path).unwrap();
        assert_eq!(root, dir.canonicalize().unwrap());
        assert_eq!(sol.unwrap().name, "demo");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_solution_names_file_after_title_and_suffixes_collisions() {
        let dir = env::temp_dir().join(format!("tie-sol-name-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("pages")).unwrap();
        fs::write(dir.join("我的知识库.tie"), "kind: other\n").unwrap();
        let path = ensure_solution_file(&dir, "我的知识库", "src_a").unwrap();
        assert_eq!(path.file_name().and_then(|n| n.to_str()), Some("我的知识库-2.tie"));
        let again = ensure_solution_file(&dir, "我的知识库", "src_a").unwrap();
        assert_eq!(again, path);
        let _ = fs::remove_dir_all(&dir);
    }
}
