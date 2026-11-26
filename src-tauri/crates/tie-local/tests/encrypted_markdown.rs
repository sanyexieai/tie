use std::{collections::HashMap, fs};
use tie_local::{
    frontmatter, is_encrypted_markdown, new_page_id, pack_tiez, parse_page,
    remap_page_links, rewrite_legacy_workspace_hrefs, unpack_tiez, ExportOptions,
    ImportStrategy, LocalWorkspace, WritePageInput, ENCRYPTED_MARKDOWN_PREFIX,
};

fn envelope(value: &str) -> String {
    format!("{ENCRYPTED_MARKDOWN_PREFIX}\n{{\"version\":1,\"ciphertext\":\"{value}\"}}\n-----END TIE ENCRYPTED MARKDOWN-----\n")
}

#[test]
fn encrypted_markdown_survives_local_history_export_import_and_pack() {
    let root = std::env::temp_dir().join(format!("tie-encrypted-roundtrip-{}", new_page_id()));
    let ws = LocalWorkspace::init(root.join("workspace"), "src_encrypted").unwrap();
    let first = envelope("opaque-body-needle");
    let saved = ws.write_page(WritePageInput {
        title: Some("Deployment credentials".into()),
        markdown: Some(first.clone()),
        tags: Some(vec!["private".into()]),
        ..Default::default()
    }).unwrap();
    let id = saved.page.id;
    assert_eq!(fs::read_to_string(saved.path).unwrap(), first);
    let page = ws.get_by_id(&id).unwrap().unwrap();
    assert_eq!(page.markdown, first);
    assert_eq!(page.title, "Deployment credentials");
    assert!(ws.search("opaque-body-needle", None, 20, false).unwrap().is_empty());
    assert!(ws.search("encrypted markdown", None, 20, false).unwrap().is_empty());
    let hits = ws.search("Deployment", Some("private"), 20, false).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].snippet, "已加密，解锁后查看正文");
    assert!(!hits[0].snippet.contains("opaque"));

    ws.write_page(WritePageInput { page_id: Some(id.clone()), title: Some("Renamed credentials".into()), ..Default::default() }).unwrap();
    assert_eq!(ws.get_by_id(&id).unwrap().unwrap().markdown, first);
    let second = envelope("another-opaque-body");
    ws.write_page(WritePageInput { page_id: Some(id.clone()), markdown: Some(second.clone()), ..Default::default() }).unwrap();
    let revisions = ws.list_revisions(&id).unwrap();
    assert!(revisions.iter().any(|item| item.title == "Deployment credentials"));
    assert!(revisions.iter().any(|item| item.title == "Renamed credentials"));
    let original = revisions.iter().find(|item| item.title == "Deployment credentials").unwrap();
    assert_eq!(ws.get_revision(&id, &original.id).unwrap().markdown, first);
    ws.restore_revision(&id, &original.id).unwrap();
    assert_eq!(ws.get_by_id(&id).unwrap().unwrap().markdown, first);
    assert!(ws.write_page(WritePageInput { page_id: Some(id.clone()), markdown: Some("ordinary replacement".into()), ..Default::default() }).unwrap_err().contains("锁定"));
    let mut unsafe_page = ws.get_by_id(&id).unwrap().unwrap();
    unsafe_page.markdown = "ordinary replacement".into();
    assert!(ws.save_full_page(unsafe_page, None).unwrap_err().contains("锁定"));
    assert_eq!(ws.get_by_id(&id).unwrap().unwrap().markdown, first);

    let exported = root.join("export");
    ws.export_closure(&id, &ExportOptions { out: Some(exported.clone()), ..Default::default() }).unwrap();
    let target = LocalWorkspace::init(root.join("import"), "src_import").unwrap();
    target.import_closure(&exported, ImportStrategy::Skip).unwrap();
    let copied = target.get_by_id(&id).unwrap().unwrap();
    assert_eq!(copied.markdown, first);
    assert_eq!(copied.title, "Deployment credentials");
    let duplicated = target.import_closure(&exported, ImportStrategy::NewId).unwrap();
    let new_id = &duplicated.pages[0].id;
    assert_ne!(new_id, &id);
    assert_eq!(target.get_by_id(new_id).unwrap().unwrap().markdown, first);

    let archive = root.join("encrypted.tiez");
    pack_tiez(ws.root(), &archive).unwrap();
    let unpacked = root.join("unpacked");
    unpack_tiez(&archive, &unpacked).unwrap();
    let unpacked = LocalWorkspace::open(&unpacked, Some("src_unpacked")).unwrap();
    assert_eq!(unpacked.get_by_id(&id).unwrap().unwrap().markdown, first);
    assert_eq!(unpacked.get_revision(&id, &original.id).unwrap().markdown, first);
    let changes = tie_local::changes::list_reviews(ws.root(), &id).unwrap();
    assert!(!changes.entries.is_empty());
    assert!(changes.entries.iter().all(|entry| entry.markdown.is_empty() && entry.quote.is_empty() && entry.body.is_empty()));
    assert!(!serde_json::to_string(&changes).unwrap().contains("opaque-body-needle"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn damaged_envelopes_are_opaque_and_keep_crlf_bytes_and_metadata_title() {
    let root = std::env::temp_dir().join(format!("tie-encrypted-damaged-{}", new_page_id()));
    let ws = LocalWorkspace::init(&root, "src_encrypted").unwrap();
    let damaged = format!("{ENCRYPTED_MARKDOWN_PREFIX}\r\n# damaged-body-only-needle\r\ntie://file/legacy\r\ntie://page/pg_old\r\n");
    assert!(is_encrypted_markdown(&damaged));
    let saved = ws.write_page(WritePageInput { title: Some("Metadata title".into()), markdown: Some(damaged.clone()), ..Default::default() }).unwrap();
    let page = ws.get_by_id(&saved.page.id).unwrap().unwrap();
    assert_eq!(page.title, "Metadata title");
    assert_eq!(page.markdown, damaged);
    let snapshot = frontmatter(&page);
    let parsed = parse_page(&snapshot).unwrap();
    assert_eq!(parsed.markdown, damaged);
    assert_eq!(parsed.title, page.title);
    assert_eq!(rewrite_legacy_workspace_hrefs(&damaged, "src_local_0123456789abcdef"), damaged);
    assert_eq!(remap_page_links(&damaged, &HashMap::from([("pg_old".into(), "pg_new".into())])), damaged);
    assert!(ws.related(&page.id).unwrap().outgoing.is_empty());
    assert!(ws.search("damaged-body-only-needle", None, 20, false).unwrap().is_empty());
    fs::remove_dir_all(root).unwrap();
}
