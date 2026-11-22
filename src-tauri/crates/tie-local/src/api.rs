//! Headless local workspace API (CLI / MCP / UI share this).

use crate::io::save_page_to_root;
use crate::links::rewrite_legacy_workspace_hrefs;
use crate::page::{frontmatter, new_page_id, normalize_page_sources, parse_page};
use crate::paths::markdown_path;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{fs, io};
use tie_common::Page;

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

    pub fn load_all(&self, include_deleted: bool) -> Result<Vec<Page>, String> {
        let mut pages = Vec::new();
        for file in self.list_page_files()? {
            match fs::read_to_string(&file) {
                Ok(content) => match parse_page(&content) {
                    Ok(page) => {
                        if include_deleted || page.deleted_at.is_none() {
                            pages.push(normalize_page_sources(page));
                        }
                    }
                    Err(_) => continue,
                },
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
        let path = markdown_path(&self.root, page_id);
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Ok(Some(normalize_page_sources(parse_page(&content)?)))
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
        let q = query.trim();
        let tag_filter = tag.map(str::trim).filter(|t| !t.is_empty()).map(|t| t.to_lowercase());
        let mut pages = self.load_all(include_deleted)?;
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
                })
            })
            .collect();
        hits.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| b.page.updated_at.cmp(&a.page.updated_at))
        });
        hits.truncate(limit);
        Ok(hits)
    }

    pub fn list_recent(&self, limit: usize, tag: Option<&str>) -> Result<Vec<SearchHit>, String> {
        self.search("", tag, limit, false)
    }

    /// Page tree under optional root (default: all top-level pages).
    pub fn tree(&self, root_id: Option<&str>) -> Result<Vec<TreeNode>, String> {
        let pages = self.load_all(false)?;
        let mut by_parent: HashMap<Option<String>, Vec<Page>> = HashMap::new();
        for page in pages {
            by_parent
                .entry(page.parent_id.clone())
                .or_default()
                .push(page);
        }
        for siblings in by_parent.values_mut() {
            siblings.sort_by(|a, b| {
                a.sort_key
                    .cmp(&b.sort_key)
                    .then_with(|| a.title.cmp(&b.title))
            });
        }

        fn build(
            parent: Option<&str>,
            by_parent: &HashMap<Option<String>, Vec<Page>>,
        ) -> Vec<TreeNode> {
            let key = parent.map(str::to_owned);
            let Some(children) = by_parent.get(&key) else {
                return Vec::new();
            };
            children
                .iter()
                .map(|page| TreeNode {
                    children: build(Some(page.id.as_str()), by_parent),
                    page: LocalWorkspace::summarize(page),
                })
                .collect()
        }

        if let Some(root) = root_id.map(str::trim).filter(|id| !id.is_empty()) {
            let page = self
                .resolve(root)?
                .ok_or_else(|| format!("页面不存在：{root}"))?;
            return Ok(vec![TreeNode {
                children: build(Some(page.id.as_str()), &by_parent),
                page: Self::summarize(&page),
            }]);
        }
        Ok(build(None, &by_parent))
    }

    fn extract_outgoing(
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
        Ok(WritePageResult {
            created,
            path: markdown_path(&self.root, &page.id).display().to_string(),
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
                Ok(content) => match parse_page(&content) {
                    Ok(page) => {
                        // Round-trip sanity: re-serialize should parse.
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
                },
                Err(error) => report.errors.push(FormatIssue {
                    file: name,
                    error: error.to_string(),
                }),
            }
        }
        Ok(report)
    }

    /// Create an empty workspace root with `pages/` (for CLI init).
    pub fn init(root: impl AsRef<Path>, source_id: &str) -> Result<Self, String> {
        let root = root.as_ref();
        fs::create_dir_all(root.join("pages")).map_err(|e| e.to_string())?;
        let source = if source_id.trim().is_empty() {
            format!("src_local_{}", &new_page_id()[3..])
        } else {
            source_id.to_owned()
        };
        Self::open(root, Some(&source))
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
    fn write_get_search_roundtrip() {
        let dir = env::temp_dir().join(format!("tie-api-{}", new_page_id()));
        let _ = fs::remove_dir_all(&dir);
        let ws = LocalWorkspace::init(&dir, "src_local_0123456789abcdef").expect("init");
        let created = ws
            .write_page(WritePageInput {
                title: Some("CLI 测试".into()),
                markdown: Some("hello tie".into()),
                tags: Some(vec!["memory".into()]),
                kind: Some("note".into()),
                ..Default::default()
            })
            .expect("write");
        assert!(created.created);
        let page = ws.get_by_id(&created.page.id).unwrap().expect("get");
        assert_eq!(page.title, "CLI 测试");
        assert!(page.tags.iter().any(|t| t == "memory"));
        let hits = ws.search("hello", None, 10, false).unwrap();
        assert!(!hits.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
