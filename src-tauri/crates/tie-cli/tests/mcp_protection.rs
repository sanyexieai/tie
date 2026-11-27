use serde_json::{json, Value};
use std::{fs, io::Write, path::Path, process::{Command, Stdio}};
use tie_local::{LocalWorkspace, WritePageInput};

const PASSWORD: &str = "  fixture-mcp-protection-password  ";
fn request(ws: &LocalWorkspace, name: &str, args: Value) -> Value {
    let mut command = Command::new(env!("CARGO_BIN_EXE_tie-cli"));
    command.args(["--workspace", ws.root().to_str().unwrap(), "mcp"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .env("TIE_APP_DATA", ws.root().join("app-data"));
    for name in ["TIE_SOURCE_ID", "TIE_MCP_URL", "TIE_MCP_TOKEN", "TIE_MCP_TOKEN_FILE", "TIE_MCP_WORKSPACE", "TIE_MCP_VIA", "TIE_PAGE_PROTECTION_INTERNAL"] { command.env_remove(name); }
    let mut child = command.spawn().unwrap();
    writeln!(child.stdin.take().unwrap(), "{}", json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": args } })).unwrap();
    let output = child.wait_with_output().unwrap();
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(!String::from_utf8_lossy(&output.stderr).contains(PASSWORD));
    response["result"].clone()
}
fn call(ws: &LocalWorkspace, name: &str, args: Value) -> Value {
    let result = request(ws, name, args);
    assert_eq!(result["isError"], false, "{result}");
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
}
fn fixture(label: &str) -> LocalWorkspace {
    let root = std::env::temp_dir().join(format!("tie-mcp-protection-{label}-{}", tie_local::new_page_id()));
    LocalWorkspace::init(root, "src_private").unwrap()
}
fn assert_disk_private(root: &Path, canaries: &[&str]) {
    for entry in fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() { assert_disk_private(&entry.path(), canaries); }
        else {
            let bytes = fs::read(entry.path()).unwrap();
            let text = String::from_utf8_lossy(&bytes);
            for canary in canaries { assert!(!text.contains(canary), "{} contains {canary}", entry.path().display()); }
        }
    }
}

#[test]
fn protected_mcp_create_read_search_edit_discuss_history_and_restore_use_per_call_authorization() {
    let ws = fixture("all-tools");
    let written = call(&ws, "tie_write", json!({"title":"Protected", "markdown":"# Protected\n\nfixture-private-original-8165", "encrypted":true,"password":PASSWORD}));
    let id = written["page"]["id"].as_str().unwrap();
    assert!(tie_local::is_encrypted_markdown(&ws.get_by_id(id).unwrap().unwrap().markdown));
    let locked = call(&ws,"tie_get",json!({"id_or_title":id}));
    assert_eq!(locked["locked"],true);
    let view = call(&ws,"tie_get",json!({"id_or_title":id,"password":PASSWORD}));
    assert_eq!(view["locked"],false);
    assert!(view["markdown"].as_str().unwrap().contains("fixture-private-original-8165"));
    assert_eq!(call(&ws,"tie_get",json!({"id_or_title":id}))["locked"],true);
    assert_eq!(request(&ws,"tie_get",json!({"id_or_title":id,"password":"wrong"}))["isError"],true);
    assert_eq!(call(&ws,"tie_search",json!({"query":"fixture-private-original-8165"}))["results"],json!([]));
    assert_eq!(call(&ws,"tie_search",json!({"query":"fixture-private-original-8165","password":PASSWORD}))["results"][0]["id"],id);
    assert_eq!(request(&ws,"tie_write",json!({"pageId":id,"markdown":"plaintext overwrite"}))["isError"],true);
    let edited = call(&ws,"tie_write",json!({"pageId":id,"markdown":"# Protected\n\nfixture-private-edited-8165","password":PASSWORD}));
    let stamp = edited["page"]["updatedAt"].as_str().unwrap();
    call(&ws,"tie_signal_add",json!({"id_or_title":id,"id":"op_private","opinionKind":"correction","body":"fixture-private-opinion-8165","quote":"fixture-private-quote-8165","baseUpdatedAt":stamp,"password":PASSWORD}));
    call(&ws,"tie_signal_add",json!({"id_or_title":id,"id":"op_reply","opinionKind":"support","body":"fixture-private-reply-8165","replyTo":"op_private","baseUpdatedAt":stamp,"password":PASSWORD}));
    call(&ws,"tie_signal_resolve",json!({"id_or_title":id,"id":"op_private","status":"resolved","resolutionNote":"fixture-private-resolution-8165","password":PASSWORD}));
    let opinions = call(&ws,"tie_signal_list",json!({"id_or_title":id,"password":PASSWORD}));
    assert!(opinions["entries"].as_array().unwrap().iter().any(|entry|entry["body"]=="fixture-private-opinion-8165" && entry["resolutionNote"]=="fixture-private-resolution-8165"));
    let history = call(&ws,"tie_history",json!({"id_or_title":id}));
    let revision = history[0]["id"].as_str().unwrap();
    assert_eq!(call(&ws,"tie_revision_get",json!({"id_or_title":id,"revisionId":revision}))["locked"],true);
    let diff = call(&ws,"tie_diff",json!({"id_or_title":id,"revisionId":revision,"password":PASSWORD}));
    assert!(diff["diff"].as_str().unwrap().contains("fixture-private-original-8165"));
    call(&ws,"tie_restore",json!({"id_or_title":id,"revisionId":revision,"expectedUpdatedAt":stamp,"password":PASSWORD}));
    assert!(call(&ws,"tie_get",json!({"id_or_title":id,"password":PASSWORD}))["markdown"].as_str().unwrap().contains("fixture-private-original-8165"));
    assert_disk_private(ws.root(), &["fixture-private-", PASSWORD]);
    fs::remove_dir_all(ws.root()).unwrap();
}

#[test]
fn mcp_conversion_preserves_identity_and_rewrites_existing_history_and_discussion() {
    let ws = fixture("conversion");
    let original = ws.write_page(WritePageInput { title:Some("Convertible".into()),markdown:Some("fixture-convert-old-1269".into()),..Default::default() }).unwrap();
    let id = original.page.id;
    let edited = call(&ws,"tie_write",json!({"pageId":id,"markdown":"fixture-convert-current-1269"}));
    call(&ws,"tie_signal_add",json!({"id_or_title":id,"opinionKind":"support","body":"fixture-convert-discussion-1269","baseUpdatedAt":edited["page"]["updatedAt"]}));
    let before = ws.protection_bundle(&id).unwrap();
    let protected = call(&ws,"tie_page_protection",json!({"id_or_title":id,"action":"convert","encrypted":true,"password":PASSWORD}));
    assert_eq!(protected["page"]["id"],id);
    assert_eq!(protected["sync"]["state"],"skipped");
    assert_disk_private(ws.root(), &["fixture-convert-", PASSWORD]);
    assert_eq!(request(&ws,"tie_page_protection",json!({"id_or_title":id,"action":"convert","encrypted":false,"password":"wrong"}))["isError"],true);
    assert!(tie_local::is_encrypted_markdown(&ws.get_by_id(&id).unwrap().unwrap().markdown));
    call(&ws,"tie_page_protection",json!({"id_or_title":id,"action":"convert","encrypted":false,"password":PASSWORD}));
    let after = ws.protection_bundle(&id).unwrap();
    assert_eq!(after.page.markdown,before.page.markdown);
    assert_eq!(after.page.id,before.page.id);
    assert!(after.revisions.len()>=before.revisions.len());
    assert!(after.reviews.entries.iter().any(|entry|entry.body=="fixture-convert-discussion-1269"));
    assert_eq!(request(&ws,"tie_internal_protection_read",json!({"id_or_title":id}))["isError"],true);
    fs::remove_dir_all(ws.root()).unwrap();
}

#[test]
fn mcp_protected_children_relations_and_scoped_search_use_the_same_page_protection() {
    let ws = fixture("children-relations");
    let target = ws.write_page(WritePageInput { title:Some("Linked target".into()),..Default::default() }).unwrap();
    let parent = call(&ws,"tie_write",json!({"title":"Protected parent","markdown":"# Protected parent\n\n[[Linked target]]","encrypted":true,"password":PASSWORD}));
    let parent_id = parent["page"]["id"].as_str().unwrap();
    assert_eq!(call(&ws,"tie_related",json!({"id_or_title":parent_id}))["outgoing"],json!([]));
    assert_eq!(call(&ws,"tie_related",json!({"id_or_title":parent_id,"password":PASSWORD}))["outgoing"][0]["id"],target.page.id);
    let child = call(&ws,"tie_write",json!({"title":"Inherited child","parentId":parent_id,"markdown":"fixture-private-child-4176","password":PASSWORD}));
    let child_id = child["page"]["id"].as_str().unwrap();
    assert!(tie_local::is_encrypted_markdown(&ws.get_by_id(child_id).unwrap().unwrap().markdown));
    assert_eq!(call(&ws,"tie_search",json!({"query":"fixture-private-child-4176","root":parent_id,"password":PASSWORD}))["results"][0]["id"],child_id);
    assert_eq!(call(&ws,"tie_search",json!({"query":"fixture-private-child-4176","root":parent_id,"exclude":[child_id],"password":PASSWORD}))["results"],json!([]));
    call(&ws,"tie_write",json!({"title":"Other password","markdown":"fixture-private-other-password-4176","encrypted":true,"password":"different fixture password"}));
    assert_eq!(call(&ws,"tie_search",json!({"query":"fixture-private-other-password-4176","password":PASSWORD}))["results"],json!([]));
    assert_disk_private(ws.root(), &["fixture-private-", PASSWORD]);
    fs::remove_dir_all(ws.root()).unwrap();
}

#[test]
fn legacy_plaintext_records_of_a_protected_page_never_bypass_mcp_unlock() {
    let ws = fixture("legacy-records");
    let saved = call(&ws,"tie_write",json!({"title":"Legacy protected","markdown":"protected current","encrypted":true,"password":PASSWORD}));
    let id = saved["page"]["id"].as_str().unwrap();
    let mut previous = ws.get_by_id(id).unwrap().unwrap();
    previous.markdown = "legacy-private-history-2501".into();
    let history = tie_local::revision_dir(ws.root(), id);
    fs::create_dir_all(&history).unwrap();
    for revision in ["legacy_a", "legacy_b"] {
        fs::write(history.join(format!("{revision}.md")),tie_local::frontmatter(&previous)).unwrap();
    }
    assert_eq!(request(&ws,"tie_revision_get",json!({"id_or_title":id,"revisionId":"legacy_a"}))["isError"],true);
    assert_eq!(request(&ws,"tie_revision_get",json!({"id_or_title":id,"revisionId":"legacy_a","password":"wrong"}))["isError"],true);
    assert_eq!(call(&ws,"tie_revision_get",json!({"id_or_title":id,"revisionId":"legacy_a","password":PASSWORD}))["markdown"],"legacy-private-history-2501");
    let diff = call(&ws,"tie_diff",json!({"id_or_title":id,"revisionId":"legacy_a","compareTo":"legacy_b"}));
    assert_eq!(diff["locked"],true);
    assert_eq!(diff["diff"],"");
    assert_eq!(request(&ws,"tie_diff",json!({"id_or_title":id,"revisionId":"legacy_a","compareTo":"legacy_b","password":"wrong"}))["isError"],true);
    let reviews = ws.root().join(".tie/reviews").join(format!("{id}.json"));
    fs::write(reviews,json!({"entries":[{"id":"old","kind":"opinion","body":"legacy-private-review-2501"}]}).to_string()).unwrap();
    assert_eq!(request(&ws,"tie_signal_list",json!({"id_or_title":id}))["isError"],true);
    assert_eq!(request(&ws,"tie_signal_list",json!({"id_or_title":id,"password":"wrong"}))["isError"],true);
    assert_eq!(call(&ws,"tie_signal_list",json!({"id_or_title":id,"password":PASSWORD}))["entries"][0]["body"],"legacy-private-review-2501");
    call(&ws,"tie_page_protection",json!({"id_or_title":id,"action":"convert","encrypted":false,"password":PASSWORD}));
    assert!(!tie_local::is_encrypted_markdown(&ws.get_by_id(id).unwrap().unwrap().markdown));
    fs::remove_dir_all(ws.root()).unwrap();
}

#[test]
fn title_only_mcp_rename_updates_the_same_heading_for_ordinary_and_protected_pages() {
    let ws = fixture("title-only");
    for encrypted in [false, true] {
        let created = call(&ws,"tie_write",json!({"title":"Original title","markdown":"# Original title\n\nKeep this body.\n","encrypted":encrypted,"password":PASSWORD}));
        let id = created["page"]["id"].as_str().unwrap();
        let saved = call(&ws,"tie_write",json!({"pageId":id,"title":"Renamed title","password":PASSWORD}));
        assert_eq!(saved["page"]["title"],"Renamed title");
        let view = call(&ws,"tie_get",json!({"id_or_title":id,"password":PASSWORD}));
        assert_eq!(view["markdown"],"# Renamed title\n\nKeep this body.");
        if encrypted {
            let opaque = ws.get_by_id(id).unwrap().unwrap().markdown;
            call(&ws,"tie_write",json!({"pageId":id,"title":"Metadata only"}));
            assert_eq!(ws.get_by_id(id).unwrap().unwrap().markdown,opaque);
        }
    }
    fs::remove_dir_all(ws.root()).unwrap();
}
