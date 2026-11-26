use crate::io::{relocate_page_file_from_path, save_page_to_root};
use crate::paths::repair_utf8_mojibake;
use crate::page::{ensure_demo, is_encrypted_markdown, merge_loaded_pages, normalize_page_sources, open_or_adopt_with_meta_index, PageMetaIndex};
use crate::paths::{find_page_file, indexed_page_file};
use crate::paths::default_workspace_root;
use crate::settings::{load, save, source_from_path, workspace_sources};
use crate::solution::{sync_root_tie_files, RootTiePage};
use tie_common::fs_path;
use tie_common::{StorageSource, Workspace, WorkspaceSettings, WorkspaceSnapshot};
use std::{collections::{hash_map::Entry, HashMap}, fs, path::PathBuf};

pub fn load_file_workspace(
    data_dir: &std::path::Path,
    workspace_id: &str,
) -> Result<WorkspaceSnapshot, String> {
    let settings = load(data_dir)?;
    let default_root = default_workspace_root(data_dir);
    let (mut sources, is_default_source) = workspace_sources(&settings, &default_root);
    if is_default_source {
        let root = PathBuf::from(&sources[0].path);
        fs::create_dir_all(root.join("pages")).map_err(|error| error.to_string())?;
        ensure_demo(&root, &sources[0].id)?;
    }
    let mut pages = Vec::new();
    for source in &mut sources {
        let root = PathBuf::from(&source.path);
        let pages_dir = root.join("pages");
        if fs::create_dir_all(&pages_dir).is_err() {
            source.available = false;
            continue;
        }
        source.available = true;
        let mut meta_index = PageMetaIndex::load(&root);
        let mut page_paths = HashMap::new();
        let mut located = Vec::new();
        let mut tie_pages = Vec::new();
        for entry in fs::read_dir(&pages_dir).map_err(|error| error.to_string())? {
            let mut path = entry.map_err(|error| error.to_string())?.path();
            if path.extension().is_some_and(|extension| extension == "md") {
                let mut page = open_or_adopt_with_meta_index(&root, &path, &source.id, Some(&mut meta_index))?;
                let title = repair_utf8_mojibake(&page.title);
                let markdown = if is_encrypted_markdown(&page.markdown) { page.markdown.clone() } else { repair_utf8_mojibake(&page.markdown) };
                if title != page.title || markdown != page.markdown {
                    page.title = title;
                    page.markdown = markdown;
                    page = save_page_to_root(&root, page, None)?;
                    path = find_page_file(&root, &page.id).ok_or("修复后的页面文件不存在")?;
                }
                if page.storage_source_id.is_empty() {
                    page.storage_source_id = source.id.clone();
                }
                if !page.storage_source_ids.iter().any(|id| id == &source.id) {
                    page.storage_source_ids.push(source.id.clone());
                }
                located.push((page.id.clone(), page.title.clone(), page.created_at.clone()));
                match page_paths.entry(page.id.clone()) {
                    Entry::Vacant(entry) => { entry.insert(path); }
                    Entry::Occupied(mut entry) => {
                        if let Some(preferred) = indexed_page_file(&root, &page.id) {
                            entry.insert(preferred);
                        }
                    }
                }
                tie_pages.push(RootTiePage {
                    id: page.id.clone(),
                    title: page.title.clone(),
                    created_at: page.created_at.clone(),
                    is_root: page.deleted_at.is_none()
                        && page.parent_id.as_deref().unwrap_or("").is_empty(),
                });
                pages.push(normalize_page_sources(page));
            }
        }
        located.sort_by(|a, b| a.2.cmp(&b.2).then_with(|| a.0.cmp(&b.0)));
        for (id, title, _) in located {
            if let Some(current) = page_paths.get(&id) {
                if let Ok(path) = relocate_page_file_from_path(&root, &id, &title, current) {
                    page_paths.insert(id, path);
                }
            }
        }
        let _ = sync_root_tie_files(&root, &source.id, &tie_pages);
    }
    Ok(WorkspaceSnapshot {
        workspace: Workspace {
            id: workspace_id.to_owned(),
            name: if settings.name.trim().is_empty() {
                "我的知识库".to_owned()
            } else {
                settings.name
            },
            sources,
        },
        pages: merge_loaded_pages(pages),
    })
}

pub fn resolve_directory_path(path: &str) -> Result<PathBuf, String> {
    let path_buf = PathBuf::from(path);
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        match path_buf.canonicalize() {
            Ok(root) if root.is_dir() => Ok(fs_path::strip_extended_length_prefix(&root)),
            Ok(_) => Err("所选路径不是目录".to_owned()),
            Err(_) if path_buf.is_dir() => Ok(fs_path::strip_extended_length_prefix(&path_buf)),
            Err(error) => Err(format!("无法打开所选目录：{error}")),
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let root = path_buf
            .canonicalize()
            .map_err(|error| format!("无法打开所选目录：{error}"))?;
        if !root.is_dir() {
            return Err("所选路径不是目录".to_owned());
        }
        Ok(fs_path::strip_extended_length_prefix(&root))
    }
}

pub fn register_storage_source(
    data_dir: &std::path::Path,
    root: PathBuf,
    kind: String,
) -> Result<Vec<StorageSource>, String> {
    if !root.is_dir() {
        return Err("所选路径不是目录".to_owned());
    }
    if !matches!(kind.as_str(), "local" | "smb") {
        return Err("不支持的存储源类型".to_owned());
    }
    fs::create_dir_all(root.join("pages")).map_err(|error| error.to_string())?;

    let existing_settings = load(data_dir)?;
    let default_root = default_workspace_root(data_dir);
    let (mut sources, _) = workspace_sources(&existing_settings, &default_root);
    let source = source_from_path(root, kind);
    if !sources.iter().any(|item| item.id == source.id) {
        sources.push(source);
    }
    let settings = WorkspaceSettings {
        name: existing_settings.name,
        path: String::new(),
        kind: String::new(),
        sources: sources.clone(),
        s3_providers: existing_settings.s3_providers,
    };
    save(data_dir, &settings)?;
    Ok(sources)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{frontmatter, page_meta_path, write_page_meta, Page};

    fn fixture_root(name: &str) -> (PathBuf, PathBuf) {
        let data = std::env::temp_dir().join(format!("tie-desktop-load-{name}-{}", crate::new_page_id()));
        let root = data.join("workspace");
        fs::create_dir_all(root.join("pages")).unwrap();
        (data, root)
    }

    fn page(id: &str, title: &str, parent: Option<&str>) -> Page {
        Page {
            id: id.into(), title: title.into(), icon: String::new(),
            parent_id: parent.map(str::to_owned), sort_key: 0,
            markdown: format!("# {title}\n\nbody of {id}\n"), tags: vec!["initial".into()],
            created_at: format!("2026-01-01T00:00:{}Z", if id.ends_with('1') { "01" } else { "02" }),
            updated_at: "2026-01-01T00:00:03Z".into(), deleted_at: None,
            storage_source_id: String::new(), storage_source_ids: Vec::new(),
        }
    }

    #[test]
    fn desktop_load_keeps_ids_bytes_and_sidecars_when_relocating_title_collisions() {
        let (data, root) = fixture_root("collision");
        let legacy = page("pg_desktop_1", "同名标题", None);
        let mut plain = page("pg_desktop_2", "同名标题", Some(&legacy.id));
        plain.markdown = "---\r\ntitle: foreign yaml\r\n---\r\n\r\nunchanged external bytes\r\n".into();
        let legacy_path = root.join("pages").join(format!("{}.md", legacy.id));
        fs::write(&legacy_path, frontmatter(&legacy)).unwrap();
        fs::write(root.join("pages/plain-old.md"), &plain.markdown).unwrap();
        write_page_meta(&root, &plain, "pages/plain-old.md").unwrap();
        let asset = root.join(".tie/assets").join(&plain.id).join("keep.txt");
        fs::create_dir_all(asset.parent().unwrap()).unwrap();
        fs::write(&asset, "keep asset").unwrap();
        let history = root.join(".tie/history").join(&plain.id).join("old.md");
        fs::create_dir_all(history.parent().unwrap()).unwrap();
        fs::write(&history, "keep history").unwrap();

        let loaded = load_file_workspace(&data, "test").unwrap();
        assert_eq!(loaded.pages.len(), 2);
        assert_eq!(loaded.pages.iter().map(|page| page.id.as_str()).collect::<std::collections::HashSet<_>>(), [&*legacy.id, &*plain.id].into_iter().collect());
        assert_eq!(find_page_file(&root, &legacy.id).unwrap().file_name().unwrap(), "同名标题.md");
        let plain_path = find_page_file(&root, &plain.id).unwrap();
        assert_eq!(plain_path.file_name().unwrap(), "同名标题-2.md");
        assert_eq!(fs::read_to_string(&plain_path).unwrap(), plain.markdown);
        assert_eq!(fs::read_to_string(find_page_file(&root, &legacy.id).unwrap()).unwrap(), frontmatter(&legacy));
        assert_eq!(fs::read_to_string(&asset).unwrap(), "keep asset");
        assert_eq!(fs::read_to_string(&history).unwrap(), "keep history");
        assert!(fs::read_to_string(page_meta_path(&root, &plain.id)).unwrap().contains("file: pages/同名标题-2.md"));
        assert!(!legacy_path.exists());
        assert!(!root.join("pages/plain-old.md").exists());

        plain.tags = vec!["external".into()];
        plain.parent_id = None;
        write_page_meta(&root, &plain, "pages/同名标题-2.md").unwrap();
        fs::write(&plain_path, "# External body\n\nupdated outside Tie\n").unwrap();
        let again = load_file_workspace(&data, "test").unwrap();
        let observed = again.pages.iter().find(|page| page.id == plain.id).unwrap();
        assert_eq!(observed.markdown, "# External body\n\nupdated outside Tie\n");
        assert_eq!(observed.tags, plain.tags);
        assert_eq!(observed.parent_id, None);
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn desktop_load_updates_known_path_after_encoding_repair() {
        let (data, root) = fixture_root("repair");
        let mut damaged = page("pg_desktop_repair", "中文标题", None);
        damaged.markdown = damaged.markdown.as_bytes().iter().map(|byte| char::from(*byte)).collect();
        damaged.title = damaged.title.as_bytes().iter().map(|byte| char::from(*byte)).collect();
        let old = root.join("pages").join(format!("{}.md", damaged.id));
        fs::write(&old, frontmatter(&damaged)).unwrap();
        let loaded = load_file_workspace(&data, "test").unwrap();
        assert_eq!(loaded.pages.len(), 1);
        assert_eq!(loaded.pages[0].id, damaged.id);
        assert_eq!(loaded.pages[0].title, "中文标题");
        let path = find_page_file(&root, &damaged.id).unwrap();
        assert_eq!(path.file_name().unwrap(), "中文标题.md");
        assert!(fs::read_to_string(&path).unwrap().starts_with("# 中文标题\n"));
        assert!(!old.exists());
        assert_eq!(load_file_workspace(&data, "test").unwrap().pages[0].id, damaged.id);
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn desktop_load_never_repairs_bytes_inside_an_encrypted_wrapper() {
        let (data, root) = fixture_root("encrypted");
        let mut document = page("pg_desktop_encrypted", "Encrypted document", None);
        let damaged = "中文".as_bytes().iter().map(|byte| char::from(*byte)).collect::<String>();
        document.markdown = format!("{}\n{damaged}\n", crate::ENCRYPTED_MARKDOWN_PREFIX);
        assert_ne!(repair_utf8_mojibake(&document.markdown), document.markdown);
        let path = root.join("pages/Encrypted document.md");
        fs::write(&path, &document.markdown).unwrap();
        write_page_meta(&root, &document, "pages/Encrypted document.md").unwrap();
        let loaded = load_file_workspace(&data, "test").unwrap();
        assert_eq!(loaded.pages[0].markdown, document.markdown);
        assert_eq!(loaded.pages[0].title, document.title);
        assert_eq!(fs::read_to_string(path).unwrap(), document.markdown);
        fs::remove_dir_all(data).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn desktop_load_keeps_sidecar_target_when_a_symlink_alias_is_enumerated_first() {
        let (data, root) = fixture_root("alias");
        let original = page("pg_desktop_alias", "Canonical", None);
        let target = root.join("pages/Canonical.md");
        std::os::unix::fs::symlink(&target, root.join("pages/alias.md")).unwrap();
        fs::write(&target, &original.markdown).unwrap();
        write_page_meta(&root, &original, "pages/Canonical.md").unwrap();
        let loaded = load_file_workspace(&data, "test").unwrap();
        assert_eq!(loaded.pages.len(), 1);
        assert_eq!(loaded.pages[0].id, original.id);
        assert_eq!(find_page_file(&root, &original.id).unwrap(), target);
        assert_eq!(fs::read_to_string(root.join("pages/alias.md")).unwrap(), original.markdown);
        assert_eq!(load_file_workspace(&data, "test").unwrap().pages[0].id, original.id);
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn desktop_load_large_mixed_workspace_preserves_all_pages_and_root_solutions() {
        let (data, root) = fixture_root("large");
        let mut expected = std::collections::HashMap::new();
        for index in 0..700 {
            let id = format!("pg_startup_{index:04}");
            let title = format!("启动文档-{index:04}");
            let document = page(&id, &title, None);
            let relative = format!("pages/{title}.md");
            if index % 2 == 0 {
                fs::write(root.join(&relative), frontmatter(&document)).unwrap();
            } else {
                fs::write(root.join(&relative), &document.markdown).unwrap();
                write_page_meta(&root, &document, &relative).unwrap();
            }
            expected.insert(id, document.markdown);
        }
        let start = std::time::Instant::now();
        let first = load_file_workspace(&data, "test").unwrap();
        let first_time = start.elapsed();
        let start = std::time::Instant::now();
        let second = load_file_workspace(&data, "test").unwrap();
        let second_time = start.elapsed();
        eprintln!("[workspace-startup] pages=700 first={}ms reopen={}ms", first_time.as_millis(), second_time.as_millis());
        for snapshot in [first, second] {
            assert_eq!(snapshot.pages.len(), expected.len());
            for page in snapshot.pages {
                assert_eq!(expected.get(&page.id), Some(&page.markdown));
                assert_eq!(page.parent_id, None);
            }
        }
        let solution_count = fs::read_dir(&root).unwrap().filter_map(Result::ok)
            .filter(|entry| entry.path().is_file() && entry.path().extension().is_some_and(|extension| extension == "tie"))
            .count();
        assert_eq!(solution_count, expected.len());
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn desktop_load_reports_unreadable_markdown_instead_of_dropping_it() {
        let (data, root) = fixture_root("invalid");
        fs::write(root.join("pages/invalid.md"), [0xff, 0xfe]).unwrap();
        assert!(load_file_workspace(&data, "test").is_err());
        let _ = fs::remove_dir_all(data);
    }
}
