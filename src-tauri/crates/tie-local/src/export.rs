//! Page-closure export / import (share a slice of pages, not a sync channel).
//!
//! Closure = root + full `parent_id` subtree (optional) + outgoing links
//! (`[[title]]` / `tie://page/{id}`) up to `depth` hops, plus `.tie/assets/{pageId}/`.
//! Not included: incoming links, `.tie/history/`, `tie://file/` registry data.

use crate::api::{LocalWorkspace, PageSummary};
use crate::page::{
    is_tie_document, new_page_id, normalize_page_sources, parse_page, read_stored_page,
    write_page_meta,
};
use crate::paths::workspace_relative;
use crate::paths::{allocate_page_path, find_page_file, page_asset_dir, sanitize_asset_name};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;
use std::{fs, thread};
use tie_common::Page;

pub const DEFAULT_EXPORT_DEPTH: usize = 2;
/// Optional manifest inside an export directory (informational; import ignores it).
pub const EXPORT_MANIFEST: &str = "export.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClosureReason {
    Root,
    Child,
    Link,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosureEntry {
    pub id: String,
    pub title: String,
    pub reason: ClosureReason,
    /// Link hops from the root/subtree seed set (0 for root and children).
    pub depth: usize,
}

#[derive(Debug, Clone)]
pub struct ExportOptions {
    pub depth: usize,
    pub with_children: bool,
    /// Output directory; default `tie-export-{rootId}` under the current dir.
    pub out: Option<PathBuf>,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            depth: DEFAULT_EXPORT_DEPTH,
            with_children: true,
            out: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub workspace: String,
    pub out_dir: String,
    pub root: PageSummary,
    pub depth: usize,
    pub with_children: bool,
    pub page_count: usize,
    pub asset_files: usize,
    pub pages: Vec<ClosureEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ImportStrategy {
    /// Keep the existing page when the id already exists (default).
    #[default]
    Skip,
    /// Replace the existing page (previous content goes to `.tie/history/`).
    Overwrite,
    /// Give pages whose id already exists a fresh id; remap `tie://page` links.
    NewId,
}

impl ImportStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Skip => "skip",
            Self::Overwrite => "overwrite",
            Self::NewId => "new-id",
        }
    }
}

impl FromStr for ImportStrategy {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_lowercase().as_str() {
            "skip" => Ok(Self::Skip),
            "overwrite" => Ok(Self::Overwrite),
            "new-id" | "new_id" | "newid" => Ok(Self::NewId),
            other => Err(format!("未知导入策略：{other}（可选 skip|overwrite|new-id）")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportAction {
    Created,
    Overwritten,
    Skipped,
    NewId,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPage {
    pub original_id: String,
    pub id: String,
    pub title: String,
    pub action: ImportAction,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub workspace: String,
    pub source_dir: String,
    pub strategy: String,
    pub created: usize,
    pub overwritten: usize,
    pub skipped: usize,
    pub new_id: usize,
    pub asset_files: usize,
    pub pages: Vec<ImportedPage>,
}

fn is_safe_page_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Pure closure collection over already-loaded (non-deleted) pages.
///
/// Seeds are the root plus (optionally) its whole `parent_id` subtree; outgoing links
/// from every seed are followed for up to `depth` hops. Linked pages do not pull in
/// their own children or incoming links.
pub fn collect_page_closure(
    pages: &[Page],
    root_id: &str,
    depth: usize,
    with_children: bool,
) -> Result<Vec<ClosureEntry>, String> {
    let by_id: HashMap<String, Page> = pages.iter().cloned().map(|p| (p.id.clone(), p)).collect();
    let by_title: HashMap<String, String> = pages
        .iter()
        .map(|p| (p.title.to_lowercase(), p.id.clone()))
        .collect();
    let root = by_id
        .get(root_id)
        .ok_or_else(|| format!("页面不存在：{root_id}"))?;

    let entry = |page: &Page, reason: ClosureReason, depth: usize| ClosureEntry {
        id: page.id.clone(),
        title: page.title.clone(),
        reason,
        depth,
    };

    let mut entries = vec![entry(root, ClosureReason::Root, 0)];
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(root.id.clone());

    if with_children {
        let mut by_parent: HashMap<&str, Vec<&Page>> = HashMap::new();
        for page in pages {
            if let Some(parent) = page.parent_id.as_deref() {
                by_parent.entry(parent).or_default().push(page);
            }
        }
        for siblings in by_parent.values_mut() {
            siblings.sort_by(|a, b| a.sort_key.cmp(&b.sort_key).then_with(|| a.title.cmp(&b.title)));
        }
        let mut queue: VecDeque<&str> = VecDeque::new();
        queue.push_back(root.id.as_str());
        while let Some(parent) = queue.pop_front() {
            for child in by_parent.get(parent).into_iter().flatten() {
                if seen.insert(child.id.clone()) {
                    entries.push(entry(child, ClosureReason::Child, 0));
                    queue.push_back(child.id.as_str());
                }
            }
        }
    }

    let mut frontier: Vec<String> = entries.iter().map(|e| e.id.clone()).collect();
    for hop in 1..=depth {
        let mut next: BTreeSet<String> = BTreeSet::new();
        for id in &frontier {
            let Some(page) = by_id.get(id) else { continue };
            for target in LocalWorkspace::extract_outgoing(page, &by_id, &by_title) {
                if !seen.contains(&target) {
                    next.insert(target);
                }
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = Vec::with_capacity(next.len());
        for id in next {
            if let Some(page) = by_id.get(&id) {
                seen.insert(id.clone());
                entries.push(entry(page, ClosureReason::Link, hop));
                frontier.push(id);
            }
        }
    }
    Ok(entries)
}

/// Rewrite `tie://page/{id}` and `tie://asset/{id}/…` using `id_map` (old → new).
pub fn remap_page_links(markdown: &str, id_map: &HashMap<String, String>) -> String {
    if id_map.is_empty() {
        return markdown.to_owned();
    }
    const PREFIXES: [&str; 2] = ["tie://page/", "tie://asset/"];
    let mut out = String::with_capacity(markdown.len());
    let mut rest = markdown;
    loop {
        let next = PREFIXES
            .iter()
            .filter_map(|prefix| rest.find(prefix).map(|index| (index, prefix.len())))
            .min_by_key(|(index, _)| *index);
        let Some((index, prefix_len)) = next else {
            out.push_str(rest);
            break;
        };
        let after = index + prefix_len;
        out.push_str(&rest[..after]);
        let tail = &rest[after..];
        let id_len = tail
            .char_indices()
            .find(|(_, c)| !is_id_char(*c))
            .map(|(i, _)| i)
            .unwrap_or(tail.len());
        let id = &tail[..id_len];
        out.push_str(id_map.get(id).map(String::as_str).unwrap_or(id));
        rest = &tail[id_len..];
    }
    out
}

/// Copy regular files (valid asset names only) from `src` into `dst`; returns file count.
fn copy_asset_files(src: &Path, dst: &Path) -> Result<usize, String> {
    if !src.is_dir() {
        return Ok(0);
    }
    let mut count = 0;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Ok(name) = sanitize_asset_name(name) else {
            continue;
        };
        if count == 0 {
            fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        }
        fs::copy(&path, dst.join(name)).map_err(|e| format!("无法复制附件：{e}"))?;
        count += 1;
    }
    Ok(count)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportManifest<'a> {
    tie_export_version: u32,
    root_id: &'a str,
    depth: usize,
    with_children: bool,
    pages: &'a [ClosureEntry],
}

impl LocalWorkspace {
    /// Export the closure of `id_or_title` into a directory (`pages/*.md` + `.tie/assets/`).
    pub fn export_closure(
        &self,
        id_or_title: &str,
        options: &ExportOptions,
    ) -> Result<ExportSummary, String> {
        let root = self
            .resolve(id_or_title)?
            .ok_or_else(|| format!("页面不存在：{id_or_title}"))?;
        if root.deleted_at.is_some() {
            return Err(format!("页面已删除：{id_or_title}"));
        }
        let pages = self.load_all(false)?;
        let entries = collect_page_closure(&pages, &root.id, options.depth, options.with_children)?;
        let included: HashSet<&str> = entries.iter().map(|e| e.id.as_str()).collect();
        let by_id: HashMap<&str, &Page> = pages.iter().map(|p| (p.id.as_str(), p)).collect();

        let out = options
            .out
            .clone()
            .unwrap_or_else(|| PathBuf::from(format!("tie-export-{}", root.id)));
        if out.exists() {
            let non_empty = out.is_dir()
                && fs::read_dir(&out)
                    .map_err(|e| e.to_string())?
                    .next()
                    .is_some();
            if !out.is_dir() || non_empty {
                return Err(format!("导出目录已存在且非空：{}", out.display()));
            }
        }
        let pages_dir = out.join("pages");
        fs::create_dir_all(&pages_dir).map_err(|e| format!("无法创建导出目录：{e}"))?;

        let mut asset_files = 0;
        for entry in &entries {
            let Some(page) = by_id.get(entry.id.as_str()) else {
                continue;
            };
            let mut page = (*page).clone();
            // Keep the package self-contained: no dangling parents, no foreign source binding.
            if page
                .parent_id
                .as_deref()
                .is_some_and(|parent| !included.contains(parent))
            {
                page.parent_id = None;
            }
            page.storage_source_id = String::new();
            page.storage_source_ids = Vec::new();
            let path = allocate_page_path(&out, &page.id, &page.title);
            fs::write(&path, &page.markdown)
                .map_err(|e| format!("无法写入导出页面：{e}"))?;
            write_page_meta(&out, &page, &workspace_relative(&out, &path)?)?;
            asset_files += copy_asset_files(
                &page_asset_dir(self.root(), &page.id),
                &page_asset_dir(&out, &page.id),
            )?;
        }

        let manifest = ExportManifest {
            tie_export_version: 1,
            root_id: &root.id,
            depth: options.depth,
            with_children: options.with_children,
            pages: &entries,
        };
        fs::create_dir_all(out.join(".tie")).map_err(|e| e.to_string())?;
        fs::write(
            out.join(".tie").join(EXPORT_MANIFEST),
            serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("无法写入导出清单：{e}"))?;

        Ok(ExportSummary {
            workspace: self.root().display().to_string(),
            out_dir: out.display().to_string(),
            root: Self::summarize(&root),
            depth: options.depth,
            with_children: options.with_children,
            page_count: entries.len(),
            asset_files,
            pages: entries,
        })
    }

    /// Import an export directory (`pages/*.md` + optional `.tie/assets/`) into this workspace.
    pub fn import_closure(
        &self,
        dir: impl AsRef<Path>,
        strategy: ImportStrategy,
    ) -> Result<ImportSummary, String> {
        let dir = dir.as_ref();
        let pages_dir = dir.join("pages");
        if !pages_dir.is_dir() {
            return Err(format!("导入目录无效：未找到 {}", pages_dir.display()));
        }

        // Parse everything first so a bad file aborts before any write.
        let mut incoming: Vec<Page> = Vec::new();
        let mut files: Vec<PathBuf> = fs::read_dir(&pages_dir)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("md"))
            .collect();
        files.sort();
        for file in files {
            let content = fs::read_to_string(&file).map_err(|e| e.to_string())?;
            let page = if is_tie_document(&content) {
                parse_page(&content).map_err(|e| format!("{}: {e}", file.display()))?
            } else {
                read_stored_page(dir, &file).map_err(|e| format!("{}: {e}", file.display()))?
            };
            if !is_safe_page_id(&page.id) {
                return Err(format!("{}: 页面 id 无效：{}", file.display(), page.id));
            }
            incoming.push(page);
        }
        if incoming.is_empty() {
            return Err("导入目录中没有页面".to_owned());
        }

        let package_ids: HashSet<String> = incoming.iter().map(|p| p.id.clone()).collect();
        let exists = |id: &str| find_page_file(self.root(), id).is_some();

        let mut id_map: HashMap<String, String> = HashMap::new();
        if strategy == ImportStrategy::NewId {
            let mut taken: HashSet<String> = package_ids.clone();
            for page in &incoming {
                if !exists(&page.id) {
                    continue;
                }
                let new_id = loop {
                    let candidate = new_page_id();
                    if !taken.contains(&candidate) && !exists(&candidate) {
                        break candidate;
                    }
                    thread::sleep(Duration::from_millis(1));
                };
                taken.insert(new_id.clone());
                id_map.insert(page.id.clone(), new_id);
            }
        }

        let source_id = self.default_source_id().to_owned();
        let mut summary = ImportSummary {
            workspace: self.root().display().to_string(),
            source_dir: dir.display().to_string(),
            strategy: strategy.as_str().to_owned(),
            created: 0,
            overwritten: 0,
            skipped: 0,
            new_id: 0,
            asset_files: 0,
            pages: Vec::new(),
        };

        for page in incoming {
            let original_id = page.id.clone();
            let already = exists(&original_id);
            if already && strategy == ImportStrategy::Skip {
                summary.skipped += 1;
                summary.pages.push(ImportedPage {
                    id: original_id.clone(),
                    original_id,
                    title: page.title,
                    action: ImportAction::Skipped,
                });
                continue;
            }
            let new_id = id_map.get(&original_id).cloned();
            let action = if new_id.is_some() {
                ImportAction::NewId
            } else if already {
                ImportAction::Overwritten
            } else {
                ImportAction::Created
            };
            let id = new_id.unwrap_or_else(|| original_id.clone());

            let mut page = page;
            page.id = id.clone();
            page.markdown = remap_page_links(&page.markdown, &id_map);
            page.parent_id = page
                .parent_id
                .map(|parent| id_map.get(&parent).cloned().unwrap_or(parent));
            page.storage_source_id = source_id.clone();
            page.storage_source_ids = if source_id.is_empty() {
                Vec::new()
            } else {
                vec![source_id.clone()]
            };
            let page = self.save_full_page(normalize_page_sources(page), None)?;

            summary.asset_files += copy_asset_files(
                &page_asset_dir(dir, &original_id),
                &page_asset_dir(self.root(), &id),
            )?;
            match action {
                ImportAction::Created => summary.created += 1,
                ImportAction::Overwritten => summary.overwritten += 1,
                ImportAction::NewId => summary.new_id += 1,
                ImportAction::Skipped => {}
            }
            summary.pages.push(ImportedPage {
                original_id,
                id,
                title: page.title,
                action,
            });
        }
        Ok(summary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(id: &str, title: &str, parent: Option<&str>, body: &str) -> Page {
        Page {
            id: id.to_owned(),
            title: title.to_owned(),
            icon: String::new(),
            parent_id: parent.map(str::to_owned),
            sort_key: 1,
            markdown: format!("# {title}\n\n{body}\n"),
            tags: Vec::new(),
            created_at: "2026-01-01T00:00:00.000Z".to_owned(),
            updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
            deleted_at: None,
            storage_source_id: "src_local_0123456789abcdef".to_owned(),
            storage_source_ids: vec!["src_local_0123456789abcdef".to_owned()],
        }
    }

    fn ids(entries: &[ClosureEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.id.as_str()).collect()
    }

    fn temp_ws(name: &str) -> (LocalWorkspace, PathBuf) {
        let dir = std::env::temp_dir().join(format!("tie-export-test-{name}-{}", new_page_id()));
        let _ = fs::remove_dir_all(&dir);
        let ws = LocalWorkspace::init(&dir, "src_local_0123456789abcdef").expect("init");
        (ws, dir)
    }

    fn chain_pages() -> Vec<Page> {
        vec![
            page("pg_a", "Alpha", None, "see [[Beta]] and tie://file/file_x"),
            page("pg_b", "Beta", None, "next tie://page/pg_c"),
            page("pg_c", "Gamma", None, "next [[Delta]]"),
            page("pg_d", "Delta", None, "end"),
            page("pg_e", "Echo", None, "points to [[Alpha]]"),
        ]
    }

    #[test]
    fn closure_follows_outgoing_links_up_to_depth() {
        let pages = chain_pages();
        let d0 = collect_page_closure(&pages, "pg_a", 0, true).unwrap();
        assert_eq!(ids(&d0), vec!["pg_a"]);
        let d1 = collect_page_closure(&pages, "pg_a", 1, true).unwrap();
        assert_eq!(ids(&d1), vec!["pg_a", "pg_b"]);
        let d2 = collect_page_closure(&pages, "pg_a", 2, true).unwrap();
        assert_eq!(ids(&d2), vec!["pg_a", "pg_b", "pg_c"]);
        assert_eq!(d2[2].reason, ClosureReason::Link);
        assert_eq!(d2[2].depth, 2);
        let d9 = collect_page_closure(&pages, "pg_a", 9, true).unwrap();
        assert_eq!(ids(&d9), vec!["pg_a", "pg_b", "pg_c", "pg_d"]);
    }

    #[test]
    fn closure_excludes_incoming_links_and_file_links() {
        let pages = chain_pages();
        let all = collect_page_closure(&pages, "pg_a", 9, true).unwrap();
        assert!(!ids(&all).contains(&"pg_e"));
        // Echo only has an incoming relation to Alpha; exporting Echo reaches Alpha outward.
        let echo = collect_page_closure(&pages, "pg_e", 1, true).unwrap();
        assert_eq!(ids(&echo), vec!["pg_e", "pg_a"]);
    }

    #[test]
    fn closure_includes_full_subtree_regardless_of_depth() {
        let pages = vec![
            page("pg_r", "Root", None, "plain"),
            page("pg_k1", "Kid1", Some("pg_r"), "plain"),
            page("pg_k2", "Kid2", Some("pg_r"), "plain"),
            page("pg_g1", "Grand", Some("pg_k1"), "plain"),
            page("pg_x", "Other", None, "plain"),
        ];
        let with = collect_page_closure(&pages, "pg_r", 0, true).unwrap();
        assert_eq!(ids(&with), vec!["pg_r", "pg_k1", "pg_k2", "pg_g1"]);
        assert!(with[1..].iter().all(|e| e.reason == ClosureReason::Child));
        let without = collect_page_closure(&pages, "pg_r", 0, false).unwrap();
        assert_eq!(ids(&without), vec!["pg_r"]);
    }

    #[test]
    fn closure_follows_links_from_subtree_and_handles_cycles() {
        let pages = vec![
            page("pg_r", "Root", None, "plain"),
            page("pg_k", "Kid", Some("pg_r"), "to [[Far]] and tie://page/pg_r"),
            page("pg_f", "Far", None, "back to [[Kid]]"),
        ];
        let out = collect_page_closure(&pages, "pg_r", 2, true).unwrap();
        assert_eq!(ids(&out), vec!["pg_r", "pg_k", "pg_f"]);
        assert!(collect_page_closure(&pages, "pg_missing", 2, true).is_err());
    }

    #[test]
    fn remap_links_rewrites_page_and_asset_ids() {
        let mut map = HashMap::new();
        map.insert("pg_old".to_owned(), "pg_new".to_owned());
        let out = remap_page_links(
            "[a](tie://page/pg_old) ![i](tie://asset/pg_old/a.png) tie://page/pg_other [[pg_old]]",
            &map,
        );
        assert_eq!(
            out,
            "[a](tie://page/pg_new) ![i](tie://asset/pg_new/a.png) tie://page/pg_other [[pg_old]]"
        );
    }

    #[test]
    fn export_then_import_roundtrip_with_assets() {
        let (src, src_dir) = temp_ws("src");
        let mut root = page("pg_a", "Alpha", Some("pg_outside"), "see [[Beta]] ![i](tie://asset/pg_a/a.png)");
        root.sort_key = 3;
        for p in [
            root,
            page("pg_b", "Beta", None, "plain"),
            page("pg_k", "Kid", Some("pg_a"), "plain"),
            page("pg_z", "Unrelated", None, "plain"),
        ] {
            src.save_full_page(p, None).unwrap();
        }
        let asset_dir = page_asset_dir(src.root(), "pg_a");
        fs::create_dir_all(&asset_dir).unwrap();
        fs::write(asset_dir.join("a.png"), b"png").unwrap();

        let out_dir = std::env::temp_dir().join(format!("tie-export-out-{}", new_page_id()));
        let summary = src
            .export_closure(
                "Alpha",
                &ExportOptions {
                    out: Some(out_dir.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(summary.page_count, 3);
        assert_eq!(summary.asset_files, 1);
        assert!(out_dir.join("pages/Alpha.md").is_file());
        assert!(!out_dir.join("pages/Unrelated.md").exists());
        assert!(out_dir.join(".tie/assets/pg_a/a.png").is_file());
        // Non-empty target is refused.
        assert!(src.export_closure("Alpha", &ExportOptions { out: Some(out_dir.clone()), ..Default::default() }).is_err());

        let (dst, dst_dir) = temp_ws("dst");
        let imported = dst.import_closure(&out_dir, ImportStrategy::Skip).unwrap();
        assert_eq!((imported.created, imported.skipped), (3, 0));
        assert_eq!(imported.asset_files, 1);
        let alpha = dst.get_by_id("pg_a").unwrap().unwrap();
        assert_eq!(alpha.parent_id, None, "dangling parent cleared on export");
        assert_eq!(alpha.sort_key, 3);
        assert_eq!(dst.get_by_id("pg_k").unwrap().unwrap().parent_id.as_deref(), Some("pg_a"));
        assert_eq!(alpha.storage_source_id, dst.default_source_id());
        assert!(page_asset_dir(dst.root(), "pg_a").join("a.png").is_file());
        assert!(dst.get_by_id("pg_z").unwrap().is_none());

        // Second import with skip: everything exists.
        let again = dst.import_closure(&out_dir, ImportStrategy::Skip).unwrap();
        assert_eq!((again.created, again.skipped), (0, 3));

        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dst_dir);
        let _ = fs::remove_dir_all(&out_dir);
    }

    #[test]
    fn import_strategies_overwrite_and_new_id() {
        let (src, src_dir) = temp_ws("strat-src");
        src.save_full_page(page("pg_a", "Alpha", None, "from export tie://page/pg_b ![i](tie://asset/pg_a/a.png)"), None).unwrap();
        src.save_full_page(page("pg_b", "Beta", Some("pg_a"), "child"), None).unwrap();
        let asset_dir = page_asset_dir(src.root(), "pg_a");
        fs::create_dir_all(&asset_dir).unwrap();
        fs::write(asset_dir.join("a.png"), b"png").unwrap();
        let out_dir = std::env::temp_dir().join(format!("tie-export-strat-{}", new_page_id()));
        src.export_closure("pg_a", &ExportOptions { out: Some(out_dir.clone()), ..Default::default() }).unwrap();

        let (dst, dst_dir) = temp_ws("strat-dst");
        dst.save_full_page(page("pg_a", "Alpha", None, "local version"), None).unwrap();

        let skipped = dst.import_closure(&out_dir, ImportStrategy::Skip).unwrap();
        assert_eq!((skipped.created, skipped.skipped), (1, 1));
        assert!(dst.get_by_id("pg_a").unwrap().unwrap().markdown.contains("local version"));

        let over = dst.import_closure(&out_dir, ImportStrategy::Overwrite).unwrap();
        assert_eq!((over.overwritten, over.created), (2, 0));
        assert!(dst.get_by_id("pg_a").unwrap().unwrap().markdown.contains("from export"));

        let renamed = dst.import_closure(&out_dir, ImportStrategy::NewId).unwrap();
        assert_eq!(renamed.new_id, 2);
        let a = renamed.pages.iter().find(|p| p.original_id == "pg_a").unwrap();
        let b = renamed.pages.iter().find(|p| p.original_id == "pg_b").unwrap();
        assert_ne!(a.id, "pg_a");
        assert_ne!(b.id, "pg_b");
        let new_a = dst.get_by_id(&a.id).unwrap().unwrap();
        assert!(new_a.markdown.contains(&format!("tie://page/{}", b.id)));
        assert!(new_a.markdown.contains(&format!("tie://asset/{}/a.png", a.id)));
        assert_eq!(dst.get_by_id(&b.id).unwrap().unwrap().parent_id.as_deref(), Some(a.id.as_str()));
        assert!(page_asset_dir(dst.root(), &a.id).join("a.png").is_file());

        assert!("bogus".parse::<ImportStrategy>().is_err());
        assert_eq!("new-id".parse::<ImportStrategy>().unwrap(), ImportStrategy::NewId);

        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dst_dir);
        let _ = fs::remove_dir_all(&out_dir);
    }
}
