//! Headless local workspace API (CLI / MCP / UI share this).

use crate::io::{list_page_revisions_from_root, read_page_revision_from_root, save_page_to_root};
use crate::links::rewrite_legacy_workspace_hrefs;
use crate::page::{
    frontmatter, is_tie_document, new_page_id, normalize_page_sources,
    open_or_adopt_with_meta_index, parse_page, read_stored_page, remove_page_assets,
    remove_page_meta, PageMetaIndex,
};
use crate::paths::{find_page_file, revision_dir};
use crate::solution::{ensure_solution_file, find_solution_file, resolve_workspace_entry};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{fs, io};
use tie_common::{Page, PageRevision};

#[derive(Debug, Clone)]
pub struct LocalWorkspace {
    root: PathBuf,
    default_source_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSummary {
    pub id: String,
    pub title: String,
    pub tags: Vec<String>,
    pub parent_id: Option<String>,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub page: PageSummary,
    pub score: i32,
    pub snippet: String,
    /// Ancestors from the top-level category to the direct parent.
    pub breadcrumb: Vec<PageSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedPages {
    pub page: PageSummary,
    pub outgoing: Vec<PageSummary>,
    pub incoming: Vec<PageSummary>,
    pub children: Vec<PageSummary>,
    pub same_tags: Vec<PageSummary>,
}

#[derive(Debug, Clone, Default)]
pub struct WritePageInput {
    pub title: Option<String>,
    pub markdown: Option<String>,
    pub page_id: Option<String>,
    pub tags: Option<Vec<String>>,
    pub parent_id: Option<Option<String>>,
    pub parent_title: Option<String>,
    pub kind: Option<String>,
    pub match_title: bool,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritePageResult {
    pub page: PageSummary,
    pub path: String,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    #[serde(flatten)]
    pub page: PageSummary,
    pub children: Vec<TreeNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeOutlineNode {
    #[serde(flatten)]
    pub page: PageSummary,
    pub children: Vec<TreeOutlineNode>,
    pub child_count: usize,
    pub children_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatIssue {
    pub file: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatCheckReport {
    pub workspace: String,
    pub ok: usize,
    pub errors: Vec<FormatIssue>,
}

impl LocalWorkspace {
    pub fn open(root: impl AsRef<Path>, default_source_id: Option<&str>) -> Result<Self, String> {
        let root = root.as_ref().canonicalize().map_err(|error| {
            format!("无法打开工作区：{error}")
        })?;
        if !root.is_dir() {
            return Err("工作区路径不是目录".to_owned());
        }
        let pages_dir = root.join("pages");
        if !pages_dir.is_dir() {
            return Err(format!("工作区无效：未找到 {}", pages_dir.display()));
        }
        let mut ws = Self {
            root,
            default_source_id: default_source_id.unwrap_or("").to_owned(),
        };
        if ws.default_source_id.trim().is_empty() {
            ws.default_source_id = ws.infer_storage_source_id();
        }
        Ok(ws)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn pages_dir(&self) -> PathBuf {
        self.root.join("pages")
    }

    pub fn default_source_id(&self) -> &str {
        &self.default_source_id
    }

    fn list_page_files(&self) -> Result<Vec<PathBuf>, String> {
        let mut files = Vec::new();
        for entry in fs::read_dir(self.pages_dir()).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
                files.push(path);
            }
        }
        Ok(files)
    }

    fn hydrate_page_source(&self, mut page: Page) -> Page {
        // 正文不再持久化 storage_source_*；加载时用工作区默认源补全。
        if page.storage_source_id.trim().is_empty() && !self.default_source_id.trim().is_empty() {
            page.storage_source_id = self.default_source_id.clone();
        }
        normalize_page_sources(page)
    }

    pub fn load_all(&self, include_deleted: bool) -> Result<Vec<Page>, String> {
        let mut pages = Vec::new();
        let mut meta_index = PageMetaIndex::load(&self.root);
        for file in self.list_page_files()? {
            match open_or_adopt_with_meta_index(
                &self.root,
                &file,
                &self.default_source_id,
                Some(&mut meta_index),
            ) {
                Ok(page) => {
                    if include_deleted || page.deleted_at.is_none() {
                        pages.push(self.hydrate_page_source(page));
                    }
                }
                Err(_) => continue,
            }
        }
        Ok(pages)
    }

    fn infer_storage_source_id(&self) -> String {
        let Ok(pages) = self.load_all(true) else {
            return String::new();
        };
        let mut counts: HashMap<String, usize> = HashMap::new();
        for page in pages {
            let id = page.storage_source_id.trim();
            if id.is_empty() {
                continue;
            }
            *counts.entry(id.to_owned()).or_default() += 1;
        }
        counts
            .into_iter()
            .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
            .map(|(id, _)| id)
            .unwrap_or_default()
    }

    pub fn get_by_id(&self, page_id: &str) -> Result<Option<Page>, String> {
        let Some(path) = find_page_file(&self.root, page_id) else {
            return Ok(None);
        };
        let page = read_stored_page(&self.root, &path)?;
        Ok(Some(self.hydrate_page_source(page)))
    }

    pub fn find_by_title(&self, title: &str) -> Result<Option<Page>, String> {
        let needle = title.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(None);
        }
        Ok(self
            .load_all(false)?
            .into_iter()
            .find(|page| page.title.to_lowercase() == needle))
    }

    pub fn resolve(&self, id_or_title: &str) -> Result<Option<Page>, String> {
        if let Some(page) = self.get_by_id(id_or_title)? {
            return Ok(Some(page));
        }
        self.find_by_title(id_or_title)
    }

    pub fn summarize(page: &Page) -> PageSummary {
        PageSummary {
            id: page.id.clone(),
            title: page.title.clone(),
            tags: page.tags.clone(),
            parent_id: page.parent_id.clone(),
            updated_at: page.updated_at.clone(),
            deleted_at: page.deleted_at.clone(),
        }
    }

    fn score_page(page: &Page, query: &str) -> i32 {
        let q = query.to_lowercase();
        let title = page.title.to_lowercase();
        let tags: Vec<String> = page.tags.iter().map(|t| t.to_lowercase()).collect();
        let body = page.markdown.to_lowercase();
        let mut score = 0;
        if title == q {
            score += 100;
        } else if title.contains(&q) {
            score += 40;
        }
        for tag in &tags {
            if tag == &q {
                score += 30;
            } else if tag.contains(&q) {
                score += 12;
            }
        }
        for token in q.split_whitespace().filter(|t| t.len() >= 2) {
            if title.contains(token) {
                score += 8;
            }
            if tags.iter().any(|tag| tag.contains(token)) {
                score += 5;
            }
            let hits = body.matches(token).count();
            if hits > 0 {
                score += hits.min(8) as i32;
            }
        }
        score
    }

    fn snippet(page: &Page, query: &str) -> String {
        let q = query.to_lowercase();
        let lines: Vec<&str> = page.markdown.lines().collect();
        if let Some(hit) = lines.iter().find(|line| line.to_lowercase().contains(&q)) {
            return hit.trim().chars().take(160).collect();
        }
        lines
            .iter()
            .find(|line| {
                let trimmed = line.trim();
                !trimmed.is_empty() && !trimmed.starts_with('#')
            })
            .map(|line| line.trim().chars().take(160).collect())
            .unwrap_or_default()
    }

    pub fn search(
        &self,
        query: &str,
        tag: Option<&str>,
        limit: usize,
        include_deleted: bool,
    ) -> Result<Vec<SearchHit>, String> {
        self.search_scoped(query, tag, limit, include_deleted, None, &[])
    }

    /// Search a category and its descendants, pruning excluded branches before scoring.
    pub fn search_scoped(
        &self,
        query: &str,
        tag: Option<&str>,
        limit: usize,
        include_deleted: bool,
        root: Option<&str>,
        exclude: &[String],
    ) -> Result<Vec<SearchHit>, String> {
        let q = query.trim();
        let tag_filter = tag.map(str::trim).filter(|t| !t.is_empty()).map(|t| t.to_lowercase());
        let mut pages = self.load_all(include_deleted)?;
        let mut by_parent: HashMap<String, Vec<String>> = HashMap::new();
        let mut summaries = HashMap::new();
        for page in &pages {
            if let Some(parent) = &page.parent_id {
                by_parent.entry(parent.clone()).or_default().push(page.id.clone());
            }
            summaries.entry(page.id.clone()).or_insert_with(|| Self::summarize(page));
        }
        let included = root.map(|key| {
            Self::resolve_scope_page(&pages, key)
                .map(|page| Self::subtree_ids(&page.id, &by_parent))
        }).transpose()?;
        let mut excluded = HashSet::new();
        for key in exclude {
            let page = Self::resolve_scope_page(&pages, key)?;
            excluded.extend(Self::subtree_ids(&page.id, &by_parent));
        }
        pages.retain(|page| {
            included.as_ref().is_none_or(|ids| ids.contains(&page.id))
                && !excluded.contains(&page.id)
        });
        if let Some(tag) = &tag_filter {
            pages.retain(|page| page.tags.iter().any(|item| item.to_lowercase() == *tag));
        }
        let limit = limit.clamp(1, 50);
        if q.is_empty() && tag_filter.is_none() {
            pages.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            return Ok(pages
                .into_iter()
                .take(limit)
                .map(|page| SearchHit {
                    snippet: Self::snippet(&page, ""),
                    breadcrumb: Self::page_breadcrumb(&page.id, &summaries),
                    page: Self::summarize(&page),
                    score: 0,
                })
                .collect());
        }
        let mut hits: Vec<SearchHit> = pages
            .into_iter()
            .filter_map(|page| {
                let score = if q.is_empty() {
                    1
                } else {
                    Self::score_page(&page, q)
                };
                if score <= 0 {
                    return None;
                }
                Some(SearchHit {
                    snippet: Self::snippet(&page, if q.is_empty() {
                        tag_filter.as_deref().unwrap_or("")
                    } else {
                        q
                    }),
                    page: Self::summarize(&page),
                    score,
                    breadcrumb: Vec::new(),
                })
            })
            .collect();
        hits.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| b.page.updated_at.cmp(&a.page.updated_at))
        });
        hits.truncate(limit);
        for hit in &mut hits {
            hit.breadcrumb = Self::page_breadcrumb(&hit.page.id, &summaries);
        }
        Ok(hits)
    }

    pub(crate) fn resolve_scope_page<'a>(pages: &'a [Page], key: &str) -> Result<&'a Page, String> {
        let key = key.trim();
        if key.is_empty() {
            return Err("分类节点不能为空，请提供页面 ID 或唯一标题".into());
        }
        if let Some(page) = pages.iter().find(|page| page.id == key) {
            return Ok(page);
        }
        let title = key.to_lowercase();
        let mut matches = pages.iter().filter(|page| page.title.to_lowercase() == title);
        let page = matches.next().ok_or_else(|| format!("分类节点不存在：{key}"))?;
        if matches.any(|other| other.id != page.id) {
            return Err(format!("分类标题不唯一：{key}；请使用页面 ID"));
        }
        Ok(page)
    }

    fn subtree_ids(root: &str, by_parent: &HashMap<String, Vec<String>>) -> HashSet<String> {
        let mut visited = HashSet::new();
        let mut pending = vec![root.to_owned()];
        while let Some(id) = pending.pop() {
            if !visited.insert(id.clone()) {
                continue;
            }
            if let Some(children) = by_parent.get(&id) {
                pending.extend(children.iter().cloned());
            }
        }
        visited
    }

    fn page_breadcrumb(id: &str, summaries: &HashMap<String, PageSummary>) -> Vec<PageSummary> {
        let mut path = Vec::new();
        let mut visited = HashSet::from([id.to_owned()]);
        let mut parent = summaries.get(id).and_then(|page| page.parent_id.as_deref());
        while let Some(id) = parent {
            if !visited.insert(id.to_owned()) {
                break;
            }
            let Some(page) = summaries.get(id) else { break };
            path.push(page.clone());
            parent = page.parent_id.as_deref();
        }
        path.reverse();
        path
    }

    pub fn list_recent(&self, limit: usize, tag: Option<&str>) -> Result<Vec<SearchHit>, String> {
        self.search("", tag, limit, false)
    }

    /// Page tree under optional root (default: all top-level pages).
    pub fn tree(&self, root_id: Option<&str>) -> Result<Vec<TreeNode>, String> {
        fn plain(node: TreeOutlineNode) -> TreeNode {
            TreeNode {
                page: node.page,
                children: node.children.into_iter().map(plain).collect(),
            }
        }
        Ok(self.tree_nodes(root_id, None)?.into_iter().map(plain).collect())
    }

    /// Return the requested number of hierarchy levels; returned roots count as level one.
    pub fn tree_outline(&self, root: Option<&str>, depth: usize) -> Result<Vec<TreeOutlineNode>, String> {
        self.tree_nodes(root, Some(depth.clamp(1, 8)))
    }

    fn tree_nodes(&self, root: Option<&str>, depth: Option<usize>) -> Result<Vec<TreeOutlineNode>, String> {
        let mut pages = self.load_all(false)?;
        pages.sort_by(|a, b| a.sort_key.cmp(&b.sort_key).then_with(|| a.title.cmp(&b.title)).then_with(|| a.id.cmp(&b.id)));
        let mut known = HashSet::new();
        pages.retain(|page| known.insert(page.id.clone()));
        let by_id: HashMap<&str, usize> = pages.iter().enumerate().map(|(index, page)| (page.id.as_str(), index)).collect();
        let mut children: HashMap<&str, Vec<usize>> = HashMap::new();
        let mut roots = Vec::new();
        for (index, page) in pages.iter().enumerate() {
            match page.parent_id.as_deref().filter(|parent| by_id.contains_key(parent)) {
                Some(parent) => children.entry(parent).or_default().push(index),
                None => roots.push(index),
            }
        }

        fn cover(index: usize, pages: &[Page], children: &HashMap<&str, Vec<usize>>, covered: &mut HashSet<usize>) {
            let mut pending = vec![index];
            while let Some(index) = pending.pop() {
                if covered.insert(index) {
                    if let Some(children) = children.get(pages[index].id.as_str()) {
                        pending.extend(children);
                    }
                }
            }
        }

        if let Some(root) = root.map(str::trim).filter(|root| !root.is_empty()) {
            let page = Self::resolve_scope_page(&pages, root)?;
            roots = vec![by_id[page.id.as_str()]];
        } else {
            let mut covered = HashSet::new();
            for &root in &roots {
                cover(root, &pages, &children, &mut covered);
            }
            // A parent cycle has no natural root. Show one existing node without rewriting data.
            for index in 0..pages.len() {
                if !covered.contains(&index) {
                    let mut anchor = index;
                    let mut chain = HashSet::new();
                    while chain.insert(anchor) {
                        match pages[anchor].parent_id.as_deref().and_then(|parent| by_id.get(parent)) {
                            Some(&parent) => anchor = parent,
                            None => break,
                        }
                    }
                    roots.push(anchor);
                    cover(anchor, &pages, &children, &mut covered);
                }
            }
        }

        fn build(index: usize, pages: &[Page], children: &HashMap<&str, Vec<usize>>, remaining: Option<usize>, ancestors: &mut HashSet<usize>) -> TreeOutlineNode {
            ancestors.insert(index);
            let direct = children.get(pages[index].id.as_str()).map(Vec::as_slice).unwrap_or(&[]);
            let nested = if remaining == Some(1) {
                Vec::new()
            } else {
                direct.iter().filter_map(|&child| {
                    if ancestors.contains(&child) {
                        None
                    } else {
                        Some(build(child, pages, children, remaining.map(|depth| depth - 1), ancestors))
                    }
                }).collect::<Vec<_>>()
            };
            ancestors.remove(&index);
            TreeOutlineNode {
                page: LocalWorkspace::summarize(&pages[index]),
                child_count: direct.len(),
                children_truncated: nested.len() != direct.len(),
                children: nested,
            }
        }
        Ok(roots.into_iter().map(|root| build(root, &pages, &children, depth, &mut HashSet::new())).collect())
    }

    pub(crate) fn extract_outgoing(
        page: &Page,
        by_id: &HashMap<String, Page>,
        by_title: &HashMap<String, String>,
    ) -> Vec<String> {
        let mut targets = HashSet::new();
        for caps in page.markdown.match_indices("tie://page/") {
            let rest = &page.markdown[caps.0 + "tie://page/".len()..];
            let id: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if by_id.contains_key(&id) {
                targets.insert(id);
            }
        }
        let mut search_from = 0;
        while let Some(start) = page.markdown[search_from..].find("[[") {
            let abs = search_from + start + 2;
            if let Some(end) = page.markdown[abs..].find("]]") {
                let title = page.markdown[abs..abs + end].trim();
                if let Some(id) = by_title.get(&title.to_lowercase()) {
                    targets.insert(id.clone());
                }
                search_from = abs + end + 2;
            } else {
                break;
            }
        }
        targets.into_iter().collect()
    }

    pub fn related(&self, id_or_title: &str) -> Result<RelatedPages, String> {
        let page = self
            .resolve(id_or_title)?
            .ok_or_else(|| format!("页面不存在：{id_or_title}"))?;
        let all = self.load_all(false)?;
        let by_id: HashMap<String, Page> = all.iter().cloned().map(|p| (p.id.clone(), p)).collect();
        let by_title: HashMap<String, String> = all
            .iter()
            .map(|p| (p.title.to_lowercase(), p.id.clone()))
            .collect();
        let outgoing_ids = Self::extract_outgoing(&page, &by_id, &by_title);
        let outgoing: Vec<PageSummary> = outgoing_ids
            .iter()
            .filter_map(|id| by_id.get(id).map(Self::summarize))
            .collect();
        let incoming: Vec<PageSummary> = all
            .iter()
            .filter(|item| item.id != page.id)
            .filter(|item| {
                Self::extract_outgoing(item, &by_id, &by_title)
                    .iter()
                    .any(|id| id == &page.id)
            })
            .map(Self::summarize)
            .collect();
        let children: Vec<PageSummary> = all
            .iter()
            .filter(|item| item.parent_id.as_deref() == Some(page.id.as_str()))
            .map(Self::summarize)
            .collect();
        let same_tags: Vec<PageSummary> = all
            .iter()
            .filter(|item| item.id != page.id)
            .filter(|item| item.tags.iter().any(|tag| page.tags.contains(tag)))
            .take(20)
            .map(Self::summarize)
            .collect();
        Ok(RelatedPages {
            page: Self::summarize(&page),
            outgoing,
            incoming,
            children,
            same_tags,
        })
    }

    fn now_iso() -> String {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // Keep ISO-ish timestamps without chrono dependency; prefer existing page stamps when present.
        // For new writes use RFC3339-like UTC via a minimal formatter.
        format_utc_millis(secs * 1000)
    }

    fn next_sort_key(&self, parent_id: Option<&str>) -> Result<i64, String> {
        if parent_id.is_none() {
            let millis = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            return Ok(millis % 1_000_000);
        }
        let siblings = self
            .load_all(false)?
            .into_iter()
            .filter(|page| page.parent_id.as_deref() == parent_id)
            .collect::<Vec<_>>();
        if siblings.is_empty() {
            return Ok(1);
        }
        Ok(siblings.iter().map(|p| p.sort_key).max().unwrap_or(0) + 1)
    }

    pub fn write_page(&self, input: WritePageInput) -> Result<WritePageResult, String> {
        let title = input.title.as_deref().unwrap_or("").trim().to_owned();
        if title.is_empty() && input.page_id.is_none() {
            return Err("创建页面需要 title".to_owned());
        }

        let existing = if let Some(page_id) = &input.page_id {
            Some(
                self.get_by_id(page_id)?
                    .ok_or_else(|| format!("页面不存在：{page_id}"))?,
            )
        } else if input.match_title {
            self.find_by_title(&title)?
        } else {
            None
        };

        let now = Self::now_iso();
        let mut tags = if let Some(tags) = input.tags {
            tags.into_iter()
                .map(|tag| tag.trim().to_owned())
                .filter(|tag| !tag.is_empty())
                .collect()
        } else {
            existing
                .as_ref()
                .map(|page| page.tags.clone())
                .unwrap_or_default()
        };

        let mut parent_id = existing.as_ref().and_then(|page| page.parent_id.clone());
        if let Some(explicit) = input.parent_id {
            parent_id = explicit.filter(|id| !id.is_empty());
        }
        if let Some(parent_title) = &input.parent_title {
            let parent = self
                .find_by_title(parent_title)?
                .ok_or_else(|| format!("父页面不存在：{parent_title}"))?;
            parent_id = Some(parent.id);
        }

        if let Some(kind) = input.kind.as_deref() {
            let kind_tags: &[&str] = match kind {
                "decision" => &["memory", "decision"],
                "bug" => &["memory", "bug"],
                "preference" => &["memory", "preference"],
                "note" => &["memory"],
                _ => &[],
            };
            for tag in kind_tags {
                if !tags.iter().any(|item| item.eq_ignore_ascii_case(tag)) {
                    tags.push((*tag).to_owned());
                }
            }
        }

        let storage_source_id = existing
            .as_ref()
            .map(|page| page.storage_source_id.clone())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| self.default_source_id.clone());

        let raw_body = input
            .markdown
            .clone()
            .or_else(|| existing.as_ref().map(|page| page.markdown.clone()))
            .unwrap_or_default();
        let headed = ensure_title_markdown(
            if title.is_empty() {
                existing
                    .as_ref()
                    .map(|page| page.title.as_str())
                    .unwrap_or("无标题")
            } else {
                &title
            },
            &raw_body,
        );
        let markdown = rewrite_legacy_workspace_hrefs(&headed, &storage_source_id);

        let mut page = Page {
            id: existing
                .as_ref()
                .map(|page| page.id.clone())
                .unwrap_or_else(new_page_id),
            title: if title.is_empty() {
                existing
                    .as_ref()
                    .map(|page| page.title.clone())
                    .unwrap_or_else(|| "无标题".to_owned())
            } else {
                title
            },
            icon: input
                .icon
                .clone()
                .or_else(|| existing.as_ref().map(|page| page.icon.clone()))
                .unwrap_or_default(),
            parent_id: parent_id.clone(),
            sort_key: existing
                .as_ref()
                .map(|page| page.sort_key)
                .unwrap_or(self.next_sort_key(parent_id.as_deref())?),
            markdown: markdown.clone(),
            tags,
            created_at: existing
                .as_ref()
                .map(|page| page.created_at.clone())
                .unwrap_or_else(|| now.clone()),
            updated_at: now,
            deleted_at: existing.as_ref().and_then(|page| page.deleted_at.clone()),
            storage_source_id: storage_source_id.clone(),
            storage_source_ids: existing
                .as_ref()
                .map(|page| page.storage_source_ids.clone())
                .unwrap_or_else(|| {
                    if storage_source_id.is_empty() {
                        Vec::new()
                    } else {
                        vec![storage_source_id]
                    }
                }),
        };

        if let Some(heading) = markdown.lines().find(|line| line.starts_with("# ")) {
            let heading_title = heading[2..].trim();
            if !heading_title.is_empty() {
                page.title = heading_title.to_owned();
            }
        }

        let created = existing.is_none();
        let page = save_page_to_root(&self.root, page, None)?;
        let path = find_page_file(&self.root, &page.id)
            .map(|path| path.display().to_string())
            .unwrap_or_default();
        Ok(WritePageResult {
            created,
            path,
            page: Self::summarize(&page),
        })
    }

    /// Persist a full `Page` (UI / sync path) into this workspace root.
    pub fn save_full_page(
        &self,
        mut page: Page,
        expected_updated_at: Option<&str>,
    ) -> Result<Page, String> {
        if page.storage_source_id.trim().is_empty() {
            page.storage_source_id = self.default_source_id.clone();
        }
        if page.storage_source_ids.is_empty() && !page.storage_source_id.is_empty() {
            page.storage_source_ids = vec![page.storage_source_id.clone()];
        }
        save_page_to_root(&self.root, page, expected_updated_at)
    }

    /// Validate every `pages/*.md` against the page-format parser.
    pub fn check_format(&self) -> Result<FormatCheckReport, String> {
        let mut report = FormatCheckReport {
            workspace: self.root.display().to_string(),
            ok: 0,
            errors: Vec::new(),
        };
        for file in self.list_page_files()? {
            let name = file
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?")
                .to_owned();
            match fs::read_to_string(&file) {
                Ok(content) => {
                    if !is_tie_document(&content) {
                        report.ok += 1;
                        continue;
                    }
                    match parse_page(&content) {
                        Ok(page) => {
                            // 旧版 Tie 头仍要能往返；普通 Markdown 上面已记为通过。
                            if let Err(error) = parse_page(&frontmatter(&page)) {
                                report.errors.push(FormatIssue {
                                    file: name,
                                    error: format!("round-trip 失败：{error}"),
                                });
                            } else {
                                report.ok += 1;
                            }
                        }
                        Err(error) => report.errors.push(FormatIssue {
                            file: name,
                            error,
                        }),
                    }
                }
                Err(error) => report.errors.push(FormatIssue {
                    file: name,
                    error: error.to_string(),
                }),
            }
        }
        Ok(report)
    }

    /// Create an empty workspace root with `pages/` and a `.tie` solution file.
    pub fn init(root: impl AsRef<Path>, source_id: &str) -> Result<Self, String> {
        let root = root.as_ref();
        fs::create_dir_all(root.join("pages")).map_err(|e| e.to_string())?;
        let source = if source_id.trim().is_empty() {
            format!("src_local_{}", &new_page_id()[3..])
        } else {
            source_id.to_owned()
        };
        let name = root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("workspace")
            .to_owned();
        ensure_solution_file(root, &name, &source)?;
        Self::open(root, Some(&source))
    }

    /// Open from a directory, `.tie` solution, or reject `.tiez` (unpack first).
    pub fn open_entry(
        entry: impl AsRef<Path>,
        default_source_id: Option<&str>,
    ) -> Result<Self, String> {
        let (root, solution) = resolve_workspace_entry(entry.as_ref())?;
        let source = default_source_id
            .map(|s| s.to_owned())
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                solution
                    .as_ref()
                    .map(|s| s.source_id.clone())
                    .filter(|s| !s.trim().is_empty())
            });
        Self::open(root, source.as_deref())
    }

    pub fn solution_path(&self) -> PathBuf {
        find_solution_file(&self.root)
            .map(|(path, _)| path)
            .unwrap_or_else(|| {
                self.root.join(format!(
                    "{}.tie",
                    self.root
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("workspace")
                ))
            })
    }

    pub fn write_solution_file(&self, name: Option<&str>) -> Result<PathBuf, String> {
        let display_name = name
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                self.root
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("workspace")
                    .to_owned()
            });
        ensure_solution_file(&self.root, &display_name, &self.default_source_id)
    }

    pub fn list_pages(&self, include_deleted: bool) -> Result<Vec<PageSummary>, String> {
        let mut pages = self.load_all(include_deleted)?;
        pages.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(pages.iter().map(Self::summarize).collect())
    }

    pub fn soft_delete(&self, id_or_title: &str) -> Result<PageSummary, String> {
        let mut page = self
            .resolve(id_or_title)?
            .ok_or_else(|| format!("页面不存在：{id_or_title}"))?;
        if page.deleted_at.is_some() {
            return Ok(Self::summarize(&page));
        }
        page.deleted_at = Some(Self::now_iso());
        page.updated_at = Self::now_iso();
        let saved = save_page_to_root(&self.root, page, None)?;
        Ok(Self::summarize(&saved))
    }

    pub fn restore_deleted(&self, id_or_title: &str) -> Result<PageSummary, String> {
        let mut page = self
            .load_all(true)?
            .into_iter()
            .find(|page| {
                page.id == id_or_title
                    || page.title.eq_ignore_ascii_case(id_or_title.trim())
            })
            .ok_or_else(|| format!("页面不存在：{id_or_title}"))?;
        if page.deleted_at.is_none() {
            return Ok(Self::summarize(&page));
        }
        page.deleted_at = None;
        page.updated_at = Self::now_iso();
        let saved = save_page_to_root(&self.root, page, None)?;
        Ok(Self::summarize(&saved))
    }

    /// Permanently remove a page file, history, and assets (must already be soft-deleted unless `force`).
    pub fn purge_page(&self, id_or_title: &str, force: bool) -> Result<PageSummary, String> {
        let page = self
            .load_all(true)?
            .into_iter()
            .find(|page| {
                page.id == id_or_title
                    || page.title.eq_ignore_ascii_case(id_or_title.trim())
            })
            .ok_or_else(|| format!("页面不存在：{id_or_title}"))?;
        if page.deleted_at.is_none() && !force {
            return Err("页面未在回收站；先 `tie delete` 或使用 --force".to_owned());
        }
        let summary = Self::summarize(&page);
        if let Some(markdown) = find_page_file(&self.root, &page.id) {
            fs::remove_file(&markdown).map_err(|e| format!("无法删除页面文件：{e}"))?;
        }
        remove_page_meta(&self.root, &page.id);
        let history = revision_dir(&self.root, &page.id);
        if history.exists() {
            fs::remove_dir_all(&history).map_err(|e| format!("无法移除页面历史：{e}"))?;
        }
        remove_page_assets(&self.root, &page.id)?;
        Ok(summary)
    }

    fn resolve_history_page(&self, id_or_title: &str) -> Result<Page, String> {
        if let Some(page) = self.get_by_id(id_or_title)? {
            return Ok(page);
        }
        let title = id_or_title.trim().to_lowercase();
        let mut matches = self.load_all(false)?.into_iter()
            .filter(|page| page.title.to_lowercase() == title);
        let page = matches.next().ok_or_else(|| format!("页面不存在：{id_or_title}"))?;
        if matches.any(|other| other.id != page.id) {
            return Err(format!("页面标题不唯一：{id_or_title}；请使用页面 ID"));
        }
        Ok(page)
    }

    pub fn list_revisions(&self, id_or_title: &str) -> Result<Vec<PageRevision>, String> {
        let page = self.resolve_history_page(id_or_title)?;
        list_page_revisions_from_root(&self.root, &page.id)
    }

    pub fn get_revision(&self, id_or_title: &str, revision_id: &str) -> Result<Page, String> {
        let page = self.resolve_history_page(id_or_title)?;
        let revision = read_page_revision_from_root(&self.root, &page.id, revision_id)?;
        Ok(self.hydrate_page_source(revision))
    }

    pub fn restore_revision(
        &self,
        id_or_title: &str,
        revision_id: &str,
    ) -> Result<PageSummary, String> {
        self.restore_revision_checked(id_or_title, revision_id, None)
    }

    pub fn restore_revision_checked(
        &self,
        id_or_title: &str,
        revision_id: &str,
        expected_updated_at: Option<&str>,
    ) -> Result<PageSummary, String> {
        let page = self.resolve_history_page(id_or_title)?;
        let revision = read_page_revision_from_root(&self.root, &page.id, revision_id)?;
        let restored = Page {
            id: page.id,
            storage_source_id: page.storage_source_id.clone(),
            storage_source_ids: if page.storage_source_ids.is_empty() {
                revision.storage_source_ids.clone()
            } else {
                page.storage_source_ids.clone()
            },
            created_at: page.created_at.clone(),
            updated_at: Self::now_iso(),
            deleted_at: page.deleted_at.clone(),
            ..revision
        };
        let saved = save_page_to_root(&self.root, restored, expected_updated_at)?;
        Ok(Self::summarize(&saved))
    }
}

pub fn ensure_title_markdown(title: &str, body: &str) -> String {
    let clean_title = {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            "无标题"
        } else {
            trimmed
        }
    };
    let text = body.trim_start_matches('\u{feff}');
    if text.lines().next().is_some_and(|line| line.starts_with("# ")) {
        return text.to_owned();
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return format!("# {clean_title}\n\n");
    }
    format!("# {clean_title}\n\n{trimmed}\n")
}

pub(crate) fn format_utc_millis_pub(millis: u64) -> String {
    format_utc_millis(millis)
}

fn format_utc_millis(millis: u64) -> String {
    // Minimal UTC formatter without chrono: good enough for CLI stamps.
    // Falls back to unix-millis string if conversion fails.
    let secs = millis / 1000;
    let ms = millis % 1000;
    match civil_from_days((secs / 86400) as i64) {
        Some((year, month, day)) => {
            let tod = secs % 86400;
            let hour = tod / 3600;
            let min = (tod % 3600) / 60;
            let sec = tod % 60;
            format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{ms:03}Z")
        }
        None => format!("{millis}"),
    }
}

fn civil_from_days(days: i64) -> Option<(i32, u32, u32)> {
    // Algorithm from civil_from_days (Howard Hinnant), days since 1970-01-01.
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    Some((year as i32, m as u32, d as u32))
}

pub fn ensure_dir_writable(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn tree_outline_depth_counts_and_full_tree_compatibility() {
        let dir = env::temp_dir().join(format!("tie-tree-outline-{}", new_page_id()));
        let ws = LocalWorkspace::init(&dir, "src_tree_outline").unwrap();
        let category = ws.write_page(WritePageInput { title: Some("Category".into()), ..Default::default() }).unwrap().page;
        let child = ws.write_page(WritePageInput { title: Some("Child".into()), parent_id: Some(Some(category.id.clone())), ..Default::default() }).unwrap().page;
        let leaf = ws.write_page(WritePageInput { title: Some("Leaf".into()), parent_id: Some(Some(child.id.clone())), ..Default::default() }).unwrap().page;
        let top = ws.tree_outline(None, 1).unwrap();
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].page.id, category.id);
        assert_eq!(top[0].child_count, 1);
        assert!(top[0].children_truncated);
        assert!(top[0].children.is_empty());
        let second = ws.tree_outline(Some(&category.id), 2).unwrap();
        assert_eq!(second[0].children.len(), 1);
        assert!(!second[0].children_truncated);
        assert_eq!(second[0].children[0].page.id, child.id);
        assert_eq!(second[0].children[0].child_count, 1);
        assert!(second[0].children[0].children_truncated);
        let complete = ws.tree(Some("Category")).unwrap();
        assert_eq!(complete[0].children[0].children[0].page.id, leaf.id);
        let json = serde_json::to_value(&complete).unwrap();
        assert!(json[0].get("childCount").is_none());
        assert!(json[0].get("childrenTruncated").is_none());
        let empty_leaf = ws.tree_outline(Some(&leaf.id), 2).unwrap();
        assert_eq!(empty_leaf[0].child_count, 0);
        assert!(!empty_leaf[0].children_truncated);
        assert!(ws.tree(Some("missing-category")).is_err());
        ws.write_page(WritePageInput { title: Some("CATEGORY".into()), ..Default::default() }).unwrap();
        assert!(ws.tree(Some("Category")).unwrap_err().contains("不唯一"));
        assert_eq!(ws.tree(Some(&category.id)).unwrap()[0].page.id, category.id);
        let mut last = leaf.id.clone();
        for level in 0..9 {
            last = ws.write_page(WritePageInput { title: Some(format!("Deep {level}")), parent_id: Some(Some(last)), ..Default::default() }).unwrap().page.id;
        }
        let capped = ws.tree_outline(Some(&category.id), usize::MAX).unwrap();
        let mut node = &capped[0];
        let mut levels = 1;
        while let Some(child) = node.children.first() {
            levels += 1;
            node = child;
        }
        assert_eq!(levels, 8);
        assert!(node.children_truncated);
        assert!(ws.tree_outline(Some(&category.id), 0).unwrap()[0].children.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn tree_outline_keeps_orphans_visible_and_cuts_parent_cycles_without_repair() {
        let dir = env::temp_dir().join(format!("tie-tree-cycle-{}", new_page_id()));
        let ws = LocalWorkspace::init(&dir, "src_tree_cycle").unwrap();
        let mut ids = Vec::new();
        for title in ["Normal", "Missing parent", "Deleted parent", "Deleted parent child", "Cycle A", "Cycle B", "Self cycle", "Cycle descendant"] {
            ids.push(ws.write_page(WritePageInput { title: Some(title.into()), ..Default::default() }).unwrap().page.id);
        }
        for (index, parent) in [(1, "pg_missing".to_owned()), (3, ids[2].clone()), (4, ids[5].clone()), (5, ids[4].clone()), (6, ids[6].clone()), (7, ids[4].clone())] {
            let mut page = ws.get_by_id(&ids[index]).unwrap().unwrap();
            page.parent_id = Some(parent);
            if index == 7 {
                page.sort_key = -1;
            }
            save_page_to_root(&dir, page, None).unwrap();
        }
        ws.soft_delete(&ids[2]).unwrap();
        let outlines = ws.tree_outline(None, 8).unwrap();
        assert!(outlines.iter().any(|node| node.page.id == ids[1]));
        assert!(outlines.iter().any(|node| node.page.id == ids[3]));
        assert!(!outlines.iter().any(|node| node.page.id == ids[7]));
        fn collect(nodes: &[TreeOutlineNode], found: &mut Vec<String>) {
            for node in nodes {
                found.push(node.page.id.clone());
                collect(&node.children, found);
            }
        }
        let mut found = Vec::new();
        collect(&outlines, &mut found);
        let expected: HashSet<String> = ids.iter().enumerate().filter(|(index, _)| *index != 2).map(|(_, id)| id.clone()).collect();
        assert_eq!(found.iter().cloned().collect::<HashSet<_>>(), expected);
        assert_eq!(found.len(), expected.len());
        let cycle = ws.tree(Some(&ids[4])).unwrap();
        let next_cycle = cycle[0].children.iter().find(|node| node.page.id == ids[5]).unwrap();
        assert!(next_cycle.children.is_empty());
        let self_cycle = ws.tree_outline(Some(&ids[6]), 8).unwrap();
        assert_eq!(self_cycle[0].child_count, 1);
        assert!(self_cycle[0].children_truncated);
        assert!(self_cycle[0].children.is_empty());
        assert_eq!(ws.get_by_id(&ids[1]).unwrap().unwrap().parent_id.as_deref(), Some("pg_missing"));
        assert_eq!(ws.get_by_id(&ids[4]).unwrap().unwrap().parent_id.as_deref(), Some(ids[5].as_str()));
        assert!(ws.tree(Some(&ids[2])).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn write_get_search_roundtrip() {
        let dir = env::temp_dir().join(format!("tie-api-{}", new_page_id()));
        let _ = fs::remove_dir_all(&dir);
        let ws = LocalWorkspace::init(&dir, "src_local_0123456789abcdef").expect("init");
        // Use ASCII title to avoid Windows source-encoding edge cases in CI shells.
        let created = ws
            .write_page(WritePageInput {
                title: Some("CLI test".into()),
                markdown: Some("hello tie".into()),
                tags: Some(vec!["memory".into()]),
                kind: Some("note".into()),
                ..Default::default()
            })
            .expect("write");
        assert!(created.created);
        let page = ws.get_by_id(&created.page.id).unwrap().expect("get");
        assert_eq!(page.title, "CLI test");
        assert!(page.tags.iter().any(|t| t == "memory"));
        assert_eq!(page.storage_source_id, "src_local_0123456789abcdef");
        let hits = ws.search("hello", None, 10, false).unwrap();
        assert!(!hits.is_empty());
        assert!(ws.solution_path().is_file());

        let deleted = ws.soft_delete(&created.page.id).unwrap();
        assert!(deleted.deleted_at.is_some());
        assert!(ws.resolve(&created.page.id).unwrap().unwrap().deleted_at.is_some());
        let restored = ws.restore_deleted(&created.page.id).unwrap();
        assert!(restored.deleted_at.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_access_rejects_foreign_snapshots_and_traversal_without_writing() {
        let dir = env::temp_dir().join(format!("tie-history-boundary-{}", new_page_id()));
        let ws = LocalWorkspace::init(&dir, "src_history").unwrap();
        let saved = ws.write_page(WritePageInput { title: Some("History".into()), markdown: Some("good".into()), ..Default::default() }).unwrap();
        let id = saved.page.id;
        ws.write_page(WritePageInput { page_id: Some(id.clone()), markdown: Some("changed".into()), ..Default::default() }).unwrap();
        let before = ws.get_by_id(&id).unwrap().unwrap();
        let count = ws.list_revisions(&id).unwrap().len();
        for invalid in ["", ".", "..", "../other/123", "/tmp/123", "C:\\history", "other\\123", "nul\0id"] {
            assert!(ws.get_revision(&id, invalid).unwrap_err().contains("版本 ID"));
            assert!(ws.restore_revision(&id, invalid).is_err());
        }
        let other = ws.write_page(WritePageInput { title: Some("Other".into()), markdown: Some("foreign".into()), ..Default::default() }).unwrap();
        let foreign = ws.get_by_id(&other.page.id).unwrap().unwrap();
        fs::write(revision_dir(&dir, &id).join("foreign.md"), frontmatter(&foreign)).unwrap();
        assert!(ws.get_revision(&id, "foreign").unwrap_err().contains("不属于"));
        assert!(ws.restore_revision(&id, "foreign").unwrap_err().contains("不属于"));
        assert!(ws.list_revisions(&id).unwrap_err().contains("不属于"));
        fs::remove_file(revision_dir(&dir, &id).join("foreign.md")).unwrap();
        assert_eq!(ws.get_by_id(&id).unwrap().unwrap().markdown, before.markdown);
        assert_eq!(ws.list_revisions(&id).unwrap().len(), count);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn checked_restore_keeps_current_identity_and_archives_previous_content() {
        let dir = env::temp_dir().join(format!("tie-history-checked-{}", new_page_id()));
        let ws = LocalWorkspace::init(&dir, "src_history").unwrap();
        let saved = ws.write_page(WritePageInput { title: Some("Original".into()), markdown: Some("good".into()), icon: Some("A".into()), tags: Some(vec!["before".into()]), ..Default::default() }).unwrap();
        let id = saved.page.id;
        let mut current = ws.get_by_id(&id).unwrap().unwrap();
        current.markdown = "# Original\n\nbad\n".into();
        current.icon = "B".into();
        current.tags = vec!["after".into()];
        current.created_at = "2025-01-01T00:00:00.000Z".into();
        current.updated_at = "2026-11-26T00:00:00.000Z".into();
        current.deleted_at = Some("2026-11-26T00:00:00.000Z".into());
        ws.save_full_page(current.clone(), None).unwrap();
        let revision = ws.list_revisions(&id).unwrap()[0].id.clone();
        assert!(ws.restore_revision_checked(&id, &revision, Some("stale")).unwrap_err().contains("重新载入"));
        assert_eq!(ws.list_revisions(&id).unwrap().len(), 1);
        assert_eq!(ws.get_by_id(&id).unwrap().unwrap().markdown, current.markdown);
        ws.restore_revision_checked(&id, &revision, Some(&current.updated_at)).unwrap();
        let restored = ws.get_by_id(&id).unwrap().unwrap();
        assert!(restored.markdown.contains("good"));
        assert_eq!(restored.icon, "A");
        assert_eq!(restored.tags, vec!["before"]);
        assert_eq!(restored.created_at, current.created_at);
        assert_eq!(restored.deleted_at, current.deleted_at);
        assert_eq!(restored.storage_source_id, current.storage_source_id);
        assert_eq!(restored.storage_source_ids, current.storage_source_ids);
        assert_eq!(restored.id, current.id);
        let revisions = ws.list_revisions(&id).unwrap();
        assert_eq!(revisions.len(), 2);
        assert!(revisions.iter().any(|revision| ws.get_revision(&id, &revision.id).unwrap().markdown == current.markdown));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn history_requires_id_for_ambiguous_titles_without_changing_either_page() {
        let dir = env::temp_dir().join(format!("tie-history-title-{}", new_page_id()));
        let ws = LocalWorkspace::init(&dir, "src_history").unwrap();
        let first = ws.write_page(WritePageInput { title: Some("Shared".into()), markdown: Some("first".into()), ..Default::default() }).unwrap();
        let second = ws.write_page(WritePageInput { title: Some("SHARED".into()), markdown: Some("second".into()), ..Default::default() }).unwrap();
        ws.write_page(WritePageInput { page_id:Some(first.page.id.clone()), markdown:Some("modified first".into()), ..Default::default() }).unwrap();
        let revision = ws.list_revisions(&first.page.id).unwrap()[0].id.clone();
        let before_first = serde_json::to_value(ws.get_by_id(&first.page.id).unwrap().unwrap()).unwrap();
        let before_second = serde_json::to_value(ws.get_by_id(&second.page.id).unwrap().unwrap()).unwrap();
        assert!(ws.list_revisions("Shared").unwrap_err().contains("不唯一"));
        assert!(ws.get_revision("Shared", &revision).unwrap_err().contains("不唯一"));
        assert!(ws.restore_revision_checked("Shared", &revision, None).unwrap_err().contains("不唯一"));
        assert_eq!(serde_json::to_value(ws.get_by_id(&first.page.id).unwrap().unwrap()).unwrap(), before_first);
        assert_eq!(serde_json::to_value(ws.get_by_id(&second.page.id).unwrap().unwrap()).unwrap(), before_second);
        assert_eq!(ws.list_revisions(&first.page.id).unwrap().len(), 1);
        assert!(ws.list_revisions(&second.page.id).unwrap().is_empty());
        assert!(ws.get_revision(&first.page.id, &revision).unwrap().markdown.contains("first"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn open_entry_from_solution() {
        let dir = env::temp_dir().join(format!("tie-open-{}", new_page_id()));
        let _ = fs::remove_dir_all(&dir);
        let ws = LocalWorkspace::init(&dir, "src_local_openentrytest01").unwrap();
        let sol = ws.solution_path();
        let opened = LocalWorkspace::open_entry(&sol, None).unwrap();
        assert_eq!(opened.default_source_id(), "src_local_openentrytest01");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_all_preserves_sidecar_priority_legacy_and_external_changes() {
        let dir = env::temp_dir().join(format!("tie-load-index-{}", new_page_id()));
        let ws = LocalWorkspace::init(&dir, "src_local_index").unwrap();
        let saved = ws.write_page(WritePageInput {
            title: Some("Registered".into()),
            markdown: Some("registered body".into()),
            tags: Some(vec!["initial".into()]),
            ..Default::default()
        }).unwrap();
        let registered = dir.join(&saved.path);
        let original_meta = crate::paths::page_meta_path(&dir, &saved.page.id);
        let duplicate_meta = crate::paths::page_meta_path(&dir, "pg_duplicate");
        fs::write(&duplicate_meta, fs::read_to_string(&original_meta).unwrap()
            .replace(&format!("id: {}\n", saved.page.id), "id: pg_duplicate\n")).unwrap();
        fs::write(dir.join(".tie/meta/invalid"), "id: pg_invalid\nfile: ../outside.md\n").unwrap();
        let expected = crate::page::open_or_adopt(&dir, &registered, "src_local_index").unwrap();

        let mut legacy = expected.clone();
        legacy.id = "pg_legacy_index".into();
        legacy.markdown = "# Legacy\n\nlegacy body\n".into();
        let legacy_file = dir.join("pages/legacy.md");
        let legacy_bytes = frontmatter(&legacy);
        fs::write(&legacy_file, &legacy_bytes).unwrap();
        let mut ignored_sidecar = legacy.clone();
        ignored_sidecar.id = "pg_ignored_legacy".into();
        crate::page::write_page_meta(&dir, &ignored_sidecar, "pages/legacy.md").unwrap();

        let plain_file = dir.join("pages/unregistered.md");
        let plain_bytes = "---\r\ntitle: Foreign YAML\r\n---\r\n\r\nplain body\r\n";
        fs::write(&plain_file, plain_bytes).unwrap();
        let pages = ws.load_all(false).unwrap();
        assert_eq!(pages.len(), 3);
        assert!(pages.iter().any(|page| page.id == expected.id && page.tags == expected.tags));
        assert!(pages.iter().any(|page| page.id == legacy.id && page.markdown == legacy.markdown));
        let adopted = pages.iter().find(|page| page.markdown == plain_bytes).unwrap();
        assert!(crate::paths::page_meta_path(&dir, &adopted.id).is_file());
        assert_eq!(fs::read_to_string(&plain_file).unwrap(), plain_bytes);
        assert_eq!(fs::read_to_string(&legacy_file).unwrap(), legacy_bytes);

        let winning_meta = crate::paths::page_meta_path(&dir, &expected.id);
        let changed = fs::read_to_string(&winning_meta).unwrap().replace("tags: [initial]", "tags: [revised]");
        fs::write(&winning_meta, changed).unwrap();
        let revised = ws.list_recent(10, Some("revised")).unwrap();
        assert_eq!(revised.len(), 1);
        assert_eq!(revised[0].page.id, expected.id);
        assert!(ws.load_all(false).unwrap().iter().any(|page| page.id == adopted.id));
        let _ = fs::remove_dir_all(&dir);
    }

    fn scoped_search_page(ws: &LocalWorkspace, title: &str, body: &str, parent: Option<&str>) -> WritePageResult {
        ws.write_page(WritePageInput {
            title: Some(title.to_owned()),
            markdown: Some(format!("# {title}\n\n{body}\n")),
            parent_id: parent.map(|id| Some(id.to_owned())),
            tags: Some(vec!["memory".into()]),
            ..Default::default()
        }).unwrap()
    }

    #[test]
    fn scoped_search_prunes_branches_before_scoring_and_limiting() {
        let dir = env::temp_dir().join(format!("tie-scoped-search-{}", new_page_id()));
        let ws = LocalWorkspace::init(&dir, "src_local_scoped").unwrap();
        let engineering = scoped_search_page(&ws, "Engineering", "needle category", None);
        let backend = scoped_search_page(&ws, "Backend", "needle category", Some(&engineering.page.id));
        let rust = scoped_search_page(&ws, "Rust ownership", "needle reference", Some(&backend.page.id));
        let frontend = scoped_search_page(&ws, "Frontend", "needle category", Some(&engineering.page.id));
        let react = scoped_search_page(&ws, "React", "needle reference", Some(&frontend.page.id));
        let cooking = scoped_search_page(&ws, "Cooking", "unrelated category", None);
        let irrelevant = scoped_search_page(&ws, "needle", "needle needle needle", Some(&cooking.page.id));

        let hits = ws.search_scoped("needle", Some("MEMORY"), 50, false, Some("engineering"), &[frontend.page.id.clone()]).unwrap();
        let found: HashSet<_> = hits.iter().map(|hit| hit.page.id.as_str()).collect();
        assert_eq!(found, HashSet::from([engineering.page.id.as_str(), backend.page.id.as_str(), rust.page.id.as_str()]));
        let rust_hit = hits.iter().find(|hit| hit.page.id == rust.page.id).unwrap();
        assert_eq!(rust_hit.breadcrumb.iter().map(|page| page.id.as_str()).collect::<Vec<_>>(), vec![engineering.page.id.as_str(), backend.page.id.as_str()]);
        assert!(!found.contains(react.page.id.as_str()));
        assert!(!found.contains(irrelevant.page.id.as_str()));

        let limited = ws.search_scoped("needle", None, 1, false, Some(&rust.page.id), &[]).unwrap();
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].page.id, rust.page.id);
        assert_eq!(ws.search("needle", None, 1, false).unwrap()[0].page.id, irrelevant.page.id);
        assert!(ws.search_scoped("needle", None, 10, false, Some(&engineering.page.id), &[engineering.page.id.clone()]).unwrap().is_empty());
        let recent = ws.search_scoped("", None, 50, false, Some(&backend.page.id), &[]).unwrap();
        assert_eq!(recent.len(), 2);
        assert!(recent.iter().all(|hit| hit.score == 0));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scoped_search_requires_unique_existing_categories() {
        let dir = env::temp_dir().join(format!("tie-scope-resolution-{}", new_page_id()));
        let ws = LocalWorkspace::init(&dir, "src_local_resolution").unwrap();
        let left = scoped_search_page(&ws, "Left", "category", None);
        let right = scoped_search_page(&ws, "Right", "category", None);
        let first = scoped_search_page(&ws, "Shared", "needle first", Some(&left.page.id));
        let second = scoped_search_page(&ws, "Shared", "needle second", Some(&right.page.id));
        assert!(ws.search_scoped("needle", None, 20, false, Some("shared"), &[]).unwrap_err().contains("不唯一"));
        assert!(ws.search_scoped("needle", None, 20, false, None, &["Shared".into()]).unwrap_err().contains("不唯一"));
        assert!(ws.search_scoped("needle", None, 20, false, Some("missing"), &[]).unwrap_err().contains("不存在"));
        assert!(ws.search_scoped("needle", None, 20, false, None, &["pg_missing".into()]).unwrap_err().contains("不存在"));
        assert!(ws.search_scoped("needle", None, 20, false, Some(" "), &[]).unwrap_err().contains("不能为空"));
        let exact = ws.search_scoped("needle", None, 20, false, Some(&second.page.id), &[]).unwrap();
        assert_eq!(exact.len(), 1);
        assert_eq!(exact[0].page.id, second.page.id);
        let global = ws.search("needle", None, 20, false).unwrap();
        assert_eq!(global.len(), 2);
        assert!(global.iter().any(|hit| hit.page.id == first.page.id));
        assert!(global.iter().any(|hit| hit.page.id == second.page.id));
        assert!(ws.search("not-present", None, 20, false).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scoped_search_handles_cycles_and_deleted_categories() {
        let dir = env::temp_dir().join(format!("tie-scope-cycle-{}", new_page_id()));
        let ws = LocalWorkspace::init(&dir, "src_local_cycle").unwrap();
        let a = scoped_search_page(&ws, "A", "needle", None);
        let b = scoped_search_page(&ws, "B", "needle", Some(&a.page.id));
        let c = scoped_search_page(&ws, "C", "needle", Some(&b.page.id));
        ws.write_page(WritePageInput {
            page_id: Some(a.page.id.clone()),
            parent_id: Some(Some(c.page.id.clone())),
            ..Default::default()
        }).unwrap();
        let hits = ws.search_scoped("needle", None, 20, false, Some(&a.page.id), &[]).unwrap();
        assert_eq!(hits.len(), 3);
        for hit in &hits {
            assert_eq!(hit.breadcrumb.len(), 2);
            let ids: HashSet<_> = hit.breadcrumb.iter().map(|page| page.id.as_str()).collect();
            assert_eq!(ids.len(), 2);
            assert!(!ids.contains(hit.page.id.as_str()));
        }
        assert!(ws.search_scoped("needle", None, 20, false, Some(&a.page.id), &[b.page.id.clone()]).unwrap().is_empty());

        let deleted = scoped_search_page(&ws, "Deleted category", "needle", None);
        ws.soft_delete(&deleted.page.id).unwrap();
        assert!(ws.search_scoped("needle", None, 20, false, Some(&deleted.page.id), &[]).is_err());
        assert_eq!(ws.search_scoped("needle", None, 20, true, Some(&deleted.page.id), &[]).unwrap().len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn load_all_reuses_new_sidecars_for_symlink_aliases() {
        let dir = env::temp_dir().join(format!("tie-load-alias-{}", new_page_id()));
        let ws = LocalWorkspace::init(&dir, "src_local_alias").unwrap();
        let file = dir.join("pages/plain.md");
        fs::write(&file, "# Same file\n\nbody\n").unwrap();
        std::os::unix::fs::symlink(&file, dir.join("pages/alias.md")).unwrap();
        let pages = ws.load_all(false).unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].id, pages[1].id);
        assert_eq!(fs::read_dir(dir.join(".tie/meta")).unwrap().count(), 1);
        let again = ws.load_all(false).unwrap();
        assert!(again.iter().all(|page| page.id == pages[0].id));
        let _ = fs::remove_dir_all(&dir);
    }
}
