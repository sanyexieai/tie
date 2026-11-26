//! Session-only workspaces for explicitly opened Markdown files outside registered workspaces.
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tie_storage::{Page, StorageSource, WorkspaceSnapshot};

#[derive(Default)]
pub(crate) struct TemporaryWorkspaces(Mutex<TemporaryStore>);

#[derive(Default)]
struct TemporaryStore {
    entries: Vec<TemporaryFile>,
}

struct TemporaryFile {
    source: StorageSource,
    page: Page,
    path: PathBuf,
    saved_bytes: Vec<u8>,
    reviews: tie_storage::local::changes::ReviewFile,
}

pub(crate) fn is_temporary(source_id: &str) -> bool {
    source_id.starts_with("src_temporary_")
}

pub(crate) fn open_file(app: &AppHandle, path: &Path, created_at: &str) -> Result<(String, String, bool), String> {
    app.state::<TemporaryWorkspaces>().0.lock().map_err(|error| error.to_string())?.open(path, created_at)
}

pub(crate) fn append_snapshot(app: &AppHandle, snapshot: &mut WorkspaceSnapshot) -> Result<(), String> {
    app.state::<TemporaryWorkspaces>().0.lock().map_err(|error| error.to_string())?.append_snapshot(snapshot);
    Ok(())
}

pub(crate) fn save_page(app: &AppHandle, page: Page, expected: Option<&str>) -> Result<Page, String> {
    app.state::<TemporaryWorkspaces>().0.lock().map_err(|error| error.to_string())?.save(page, expected)
}

pub(crate) fn list_reviews(app: &AppHandle, source_id: &str, page_id: &str) -> Result<tie_storage::local::changes::ReviewFile, String> {
    let state = app.state::<TemporaryWorkspaces>();
    let store = state.0.lock().map_err(|error| error.to_string())?;
    Ok(store.find(source_id, page_id)?.reviews.clone())
}

pub(crate) fn page_file_path(app: &AppHandle, source_id: &str, page_id: &str) -> Result<PathBuf, String> {
    let state = app.state::<TemporaryWorkspaces>();
    let store = state.0.lock().map_err(|error| error.to_string())?;
    Ok(store.find(source_id, page_id)?.path.clone())
}

pub(crate) fn close_source(app: &AppHandle, source_id: &str) -> Result<(), String> {
    app.state::<TemporaryWorkspaces>().0.lock().map_err(|error| error.to_string())?.close(source_id)
}

pub(crate) fn rename_source(app: &AppHandle, source_id: &str, name: &str) -> Result<(), String> {
    let state = app.state::<TemporaryWorkspaces>();
    let mut store = state.0.lock().map_err(|error| error.to_string())?;
    let entry = store.entries.iter_mut().find(|entry| entry.source.id == source_id).ok_or("临时工作区已关闭")?;
    entry.source.name = name.to_owned();
    Ok(())
}

pub(crate) fn unsupported() -> String {
    "临时工作区仅编辑原 Markdown 文件，不支持此操作；请先将文件导入正式工作区".to_owned()
}

impl TemporaryStore {
    fn open(&mut self, path: &Path, created_at: &str) -> Result<(String, String, bool), String> {
        if let Some(entry) = self.entries.iter_mut().find(|entry| tie_storage::fs_path::paths_equal(&entry.path, path)) {
            entry.refresh();
            return Ok((entry.page.id.clone(), entry.source.id.clone(), false));
        }
        let markdown = fs::read_to_string(path).map_err(|error| format!("无法读取 Markdown 文件：{error}"))?;
        let mut hash = DefaultHasher::new();
        path.hash(&mut hash);
        let suffix = format!("{:016x}", hash.finish());
        let source_id = format!("src_temporary_{suffix}");
        let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("Markdown");
        let title = markdown_title(&markdown, path);
        let revision_millis = now_millis();
        let page = Page {
            id: format!("pg_temporary_{suffix}"), title, icon: String::new(), parent_id: None,
            sort_key: 0, markdown: markdown.clone(), tags: Vec::new(), created_at: created_at.to_owned(),
            updated_at: tie_storage::local::format_utc_millis_pub(revision_millis), deleted_at: None,
            storage_source_id: source_id.clone(), storage_source_ids: vec![source_id.clone()],
        };
        let id = page.id.clone();
        self.entries.push(TemporaryFile {
            source: StorageSource {
                id: source_id.clone(), name: file_name.to_owned(), kind: "local".to_owned(),
                path: path.parent().unwrap_or(Path::new(".")).display().to_string(), available: true, temporary: true,
            },
            saved_bytes: markdown.into_bytes(), path: path.to_owned(), page, reviews: Default::default(),
        });
        Ok((id, source_id, true))
    }

    fn find(&self, source_id: &str, page_id: &str) -> Result<&TemporaryFile, String> {
        self.entries.iter().find(|entry| entry.source.id == source_id && entry.page.id == page_id)
            .ok_or_else(|| "临时文件已关闭或不属于该工作区".to_owned())
    }

    fn append_snapshot(&mut self, snapshot: &mut WorkspaceSnapshot) {
        for entry in &mut self.entries {
            entry.refresh();
            snapshot.workspace.sources.push(entry.source.clone());
            snapshot.pages.push(entry.page.clone());
        }
    }

    fn save(&mut self, mut page: Page, expected: Option<&str>) -> Result<Page, String> {
        let entry = self.entries.iter_mut().find(|entry| entry.source.id == page.storage_source_id && entry.page.id == page.id)
            .ok_or("临时文件已关闭或不属于该工作区")?;
        if page.parent_id.is_some() || page.deleted_at.is_some() {
            return Err(unsupported());
        }
        if tie_storage::local::is_encrypted_markdown(&entry.page.markdown)
            && !tie_storage::local::is_encrypted_markdown(&page.markdown)
        {
            return Err("加密页面处于锁定状态，不能用普通正文覆盖".to_owned());
        }
        let current = fs::read(&entry.path).map_err(|error| format!("无法读取原 Markdown 文件，不能保存：{error}"))?;
        if let Some(expected) = expected {
            if entry.page.updated_at != expected || current != entry.saved_bytes {
                return Err("页面文件已在磁盘上被修改，请重新载入后再保存".to_owned());
            }
        }
        if current != page.markdown.as_bytes() {
            fs::write(&entry.path, page.markdown.as_bytes()).map_err(|error| format!("无法保存原 Markdown 文件：{error}"))?;
        }
        page.storage_source_ids = vec![entry.source.id.clone()];
        page.created_at = entry.page.created_at.clone();
        page.updated_at = tie_storage::local::next_updated_at(Some(&entry.page.updated_at));
        if let Some(change) = tie_storage::local::changes::change_entry(Some(&entry.page), Some(&page), None)? { entry.reviews.entries.push(change); }
        entry.saved_bytes = page.markdown.as_bytes().to_vec();
        entry.source.available = true;
        entry.page = page.clone();
        Ok(page)
    }

    fn close(&mut self, source_id: &str) -> Result<(), String> {
        let count = self.entries.len();
        self.entries.retain(|entry| entry.source.id != source_id);
        if self.entries.len() == count { return Err("临时工作区已关闭".to_owned()); }
        Ok(())
    }
}

impl TemporaryFile {
    fn refresh(&mut self) {
        match fs::read_to_string(&self.path) {
            Ok(markdown) => {
                self.source.available = true;
                if markdown.as_bytes() != self.saved_bytes {
                    self.page.title = markdown_title(&markdown, &self.path);
                    self.page.updated_at = tie_storage::local::format_utc_millis_pub(now_millis());
                    self.saved_bytes = markdown.as_bytes().to_vec();
                    self.page.markdown = markdown;
                }
            }
            Err(_) => { self.source.available = false; }
        }
    }
}

fn markdown_title(markdown: &str, path: &Path) -> String {
    let body = if tie_storage::local::is_encrypted_markdown(markdown) { "" } else { markdown };
    body.trim_start_matches('\u{feff}').lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim).filter(|title| !title.is_empty()))
        .unwrap_or_else(|| path.file_stem().and_then(|name| name.to_str()).unwrap_or("Markdown"))
        .to_owned()
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use tie_storage::Workspace;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("tie-temporary-{}", tie_storage::local::new_page_id()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn file(&self, name: &str, markdown: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, markdown).unwrap();
            path
        }
        fn names(&self) -> Vec<String> {
            let mut names = fs::read_dir(&self.0).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect::<Vec<_>>();
            names.sort(); names
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    fn snapshot() -> WorkspaceSnapshot {
        WorkspaceSnapshot { workspace: Workspace { id: "test".to_owned(), name: "Test".to_owned(), sources: Vec::new() }, pages: Vec::new() }
    }

    #[test]
    fn open_save_close_preserves_original_file_and_creates_no_workspace_files() {
        let fixture = Fixture::new();
        let original = "\u{feff}---\ncategory: outside\n---\n\n# External title\r\n\r\nOriginal body\r\n";
        let path = fixture.file("original-name.md", original);
        let settings = fixture.file("workspace-settings.json", "{\"sources\":[]}");
        let before_settings = fs::read(&settings).unwrap();
        let mut store = TemporaryStore::default();
        let (id, source, created) = store.open(&path, "2026-11-26T00:00:00.000Z").unwrap();
        assert!(created);
        assert_eq!(store.entries[0].page.markdown, original);
        assert_eq!(store.entries[0].page.title, "External title");
        assert!(store.entries[0].source.temporary);
        assert_eq!(store.open(&path, "later").unwrap(), (id, source.clone(), false));
        let mut loaded = snapshot(); store.append_snapshot(&mut loaded);
        assert_eq!(loaded.pages.len(), 1);
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let expected = loaded.pages[0].updated_at.clone();
        let mut edited = loaded.pages[0].clone();
        edited.title = "A changed title".to_owned();
        edited.markdown = original.replace("External title", "A changed title").replace("Original body", "Edited body");
        let saved = store.save(edited.clone(), Some(&expected)).unwrap();
        assert_eq!(saved.markdown, fs::read_to_string(&path).unwrap());
        assert_eq!(saved.title, "A changed title");
        assert_eq!(store.entries[0].reviews.entries.len(), 1);
        assert_eq!(store.entries[0].reviews.entries[0].kind, "change");
        assert_eq!(fixture.names(), vec!["original-name.md", "workspace-settings.json"]);
        assert_eq!(fs::read(&settings).unwrap(), before_settings);
        store.close(&source).unwrap();
        let mut closed = snapshot(); store.append_snapshot(&mut closed);
        assert!(closed.pages.is_empty() && closed.workspace.sources.is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), edited.markdown);
        assert!(TemporaryStore::default().entries.is_empty());
    }

    #[test]
    fn encrypted_temporary_markdown_preserves_wrapper_and_rejects_plaintext_overwrite() {
        let fixture = Fixture::new();
        let original = "-----BEGIN TIE ENCRYPTED MARKDOWN-----\r\n# Damaged payload heading\r\n";
        let path = fixture.file("Encrypted document.md", original);
        let mut store = TemporaryStore::default();
        store.open(&path, "2026-11-26T00:00:00.000Z").unwrap();
        let mut page = store.entries[0].page.clone();
        assert_eq!(page.title, "Encrypted document");
        assert_eq!(page.markdown, original);
        page.markdown = "ordinary replacement".into();
        assert!(store.save(page, None).unwrap_err().contains("锁定"));
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn external_edits_reject_save_before_and_after_snapshot_refresh() {
        let fixture = Fixture::new(); let path = fixture.file("outside.md", "# Outside\n\noriginal");
        let mut store = TemporaryStore::default(); store.open(&path, "2026-11-26T00:00:00.000Z").unwrap();
        let original = store.entries[0].page.clone();
        fs::write(&path, "# External edit\n\nchanged elsewhere").unwrap();
        let mut edited = original.clone(); edited.markdown.push_str("\nunsaved draft");
        assert!(store.save(edited.clone(), Some(&original.updated_at)).unwrap_err().contains("磁盘上被修改"));
        // Separate the initial read and refresh, as they are separate IPC calls in the editor.
        std::thread::sleep(std::time::Duration::from_millis(2));
        let mut latest = snapshot(); store.append_snapshot(&mut latest);
        assert!(latest.pages[0].markdown.contains("changed elsewhere"));
        assert!(store.save(edited.clone(), Some(&original.updated_at)).unwrap_err().contains("磁盘上被修改"));
        assert!(fs::read_to_string(&path).unwrap().contains("changed elsewhere"));
        let forced = store.save(edited, None).unwrap();
        assert!(forced.markdown.contains("unsaved draft"));
        assert_eq!(fixture.names(), vec!["outside.md"]);
    }

    #[test]
    fn missing_and_unsupported_operations_do_not_recreate_or_move_the_file() {
        let fixture = Fixture::new(); let path = fixture.file("outside.markdown", "# Outside");
        let mut store = TemporaryStore::default(); let (_, source, _) = store.open(&path, "2026-11-26T00:00:00.000Z").unwrap();
        let mut page = store.entries[0].page.clone(); let stamp = page.updated_at.clone();
        page.parent_id = Some("pg_other".to_owned());
        assert!(store.save(page, Some(&stamp)).unwrap_err().contains("不支持此操作"));
        let mut page = store.entries[0].page.clone(); page.id = "pg_unregistered_child".to_owned();
        assert!(store.save(page, None).is_err());
        let page = store.entries[0].page.clone(); fs::remove_file(&path).unwrap();
        let mut latest = snapshot(); store.append_snapshot(&mut latest);
        assert!(!latest.workspace.sources[0].available);
        assert!(store.save(page, None).is_err());
        assert!(fixture.names().is_empty());
        store.close(&source).unwrap();
    }

    #[test]
    fn tie_frontmatter_in_an_external_file_is_kept_verbatim() {
        let fixture = Fixture::new();
        let text = "---\ntie_version: 1\nid: pg_legacy\n---\n\n# Legacy external\n";
        let path = fixture.file("legacy.md", text);
        let mut store = TemporaryStore::default(); store.open(&path, "2026-11-26T00:00:00.000Z").unwrap();
        assert_ne!(store.entries[0].page.id, "pg_legacy");
        assert_eq!(store.entries[0].page.markdown, text);
        assert_eq!(fixture.names(), vec!["legacy.md"]);
    }

    #[test]
    fn loose_readme_under_registered_root_opens_temporarily_without_importing_it() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.0.join("pages")).unwrap();
        let registered = fixture.file("pages/existing.md", "# Existing page\n");
        let loose = fixture.file("README.md", "# Project readme\n\nKeep this file in place.\n");
        let source = tie_storage::local::source_from_path(fixture.0.clone(), "local".to_owned());
        let sources = vec![source];
        let formal_id = super::super::existing_registered_page(&sources, &registered).unwrap();
        let before_meta = fs::read_dir(fixture.0.join(".tie/meta")).unwrap().count();
        let before_names = fixture.names();
        let before_readme = fs::read(&loose).unwrap();
        assert!(super::super::existing_registered_page(&sources, &loose).is_none());
        let mut store = TemporaryStore::default();
        let (loose_id, _, created) = store.open(&loose, "2026-11-26T00:00:00.000Z").unwrap();
        assert!(created);
        assert_ne!(formal_id, loose_id);
        assert!(store.entries[0].source.temporary);
        assert_eq!(store.entries[0].path, loose);
        let mut loaded = snapshot(); store.append_snapshot(&mut loaded);
        assert_eq!(loaded.pages[0].markdown.as_bytes(), before_readme);
        assert_eq!(fs::read(&loose).unwrap(), before_readme);
        assert_eq!(fs::read_dir(fixture.0.join("pages")).unwrap().count(), 1);
        assert_eq!(fs::read_dir(fixture.0.join(".tie/meta")).unwrap().count(), before_meta);
        assert_eq!(fixture.names(), before_names);
        assert_eq!(super::super::existing_registered_page(&sources, &registered).unwrap(), formal_id);
    }
}
