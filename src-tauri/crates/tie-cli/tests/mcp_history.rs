use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread::{self, JoinHandle},
    time::Duration,
};
use tie_local::{LocalWorkspace, WritePageInput};

struct Agent {
    directory: PathBuf,
    workspace: LocalWorkspace,
    child: Child,
    input: ChildStdin,
    output: Receiver<Value>,
    reader: Option<JoinHandle<()>>,
    next_id: u64,
}

impl Agent {
    fn start() -> Self {
        let directory = std::env::temp_dir().join(format!("tie-mcp-history-{}", tie_local::new_page_id()));
        let workspace = LocalWorkspace::init(directory.join("workspace"), "src_history").unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_tie-cli"));
        command.arg("mcp").current_dir(&directory)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        for key in ["TIE_SOURCE_ID", "TIE_MCP_URL", "TIE_MCP_TOKEN", "TIE_MCP_TOKEN_FILE", "TIE_MCP_WORKSPACE", "TIE_MCP_VIA"] {
            command.env_remove(key);
        }
        command.env("TIE_WORKSPACE", workspace.root()).env("TIE_APP_DATA", directory.join("app-data"))
            .env("TIE_ACTOR", "History integration test");
        let mut child = command.spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, output) = mpsc::channel();
        let reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if sender.send(serde_json::from_str(&line.unwrap()).unwrap()).is_err() {
                    break;
                }
            }
        });
        Self { directory, workspace, child, input, output, reader: Some(reader), next_id: 0 }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        writeln!(self.input, "{}", json!({"jsonrpc":"2.0", "id":self.next_id, "method":method, "params":params})).unwrap();
        self.input.flush().unwrap();
        let response = self.output.recv_timeout(Duration::from_secs(10)).expect("MCP response");
        assert_eq!(response["id"], self.next_id);
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    }

    fn call(&mut self, name: &str, arguments: Value) -> Value {
        let result = self.request("tools/call", json!({"name": name, "arguments": arguments}));
        assert_eq!(result["isError"], false, "{result}");
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
    }

    fn rejected(&mut self, name: &str, arguments: Value) {
        let result = self.request("tools/call", json!({"name": name, "arguments": arguments}));
        assert_eq!(result["isError"], true, "{result}");
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.reader.take().unwrap().join().unwrap();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn history_diff_and_restore_roundtrip_preserves_both_versions_and_audits_restore() {
    let mut agent = Agent::start();
    agent.request("initialize", json!({"protocolVersion":"2025-06-18", "capabilities":{}, "clientInfo":{"name":"history-test","version":"1"}}));
    let tools = agent.request("tools/list", json!({}));
    for name in ["tie_history", "tie_revision_get", "tie_diff", "tie_restore"] {
        assert!(tools["tools"].as_array().unwrap().iter().any(|tool| tool["name"] == name));
    }
    let saved = agent.call("tie_write", json!({"title":"Original", "markdown":"# Original\n\nGood.\n", "tags":["before"], "icon":"A"}));
    let id = saved["page"]["id"].as_str().unwrap().to_owned();
    assert_eq!(agent.call("tie_history", json!({"id_or_title":id})), json!([]));
    agent.call("tie_write", json!({"pageId":id, "title":"Modified", "markdown":"# Modified\n\nBroken.\n", "tags":["after"], "icon":"B"}));
    let history = agent.call("tie_history", json!({"id_or_title":id}));
    assert_eq!(history.as_array().unwrap().len(), 1);
    assert!(history[0].get("markdown").is_none());
    let revision = history[0]["id"].as_str().unwrap().to_owned();
    let previous = agent.call("tie_revision_get", json!({"id_or_title":id, "revisionId":revision}));
    assert_eq!(previous["title"], "Original");
    assert_eq!(previous["tags"], json!(["before"]));
    let difference = agent.call("tie_diff", json!({"id_or_title":id, "revisionId":revision}));
    assert_eq!(difference["pageId"], id);
    assert_eq!(difference["toRevisionId"], "current");
    assert_eq!(difference["changed"], true);
    for field in ["title", "icon", "tags"] {
        assert!(difference["metadataChanges"].as_array().unwrap().iter().any(|change| change["field"] == field));
    }
    assert!(difference["diff"].as_str().unwrap().contains("-Good."));
    assert!(difference["diff"].as_str().unwrap().contains("+Broken."));
    let restored = agent.call("tie_restore", json!({"id_or_title":id, "revisionId":revision, "expectedUpdatedAt":difference["currentUpdatedAt"], "actor":"Restore tester"}));
    assert_eq!(restored["restored"], true);
    assert_eq!(restored["revisionId"], revision);
    assert_eq!(restored["page"]["title"], "Original");
    assert_eq!(restored["sync"]["state"], "skipped");
    let current = agent.call("tie_get", json!({"id_or_title":id}));
    assert!(current["markdown"].as_str().unwrap().contains("Good."));
    assert_eq!(current["icon"], "A");
    assert_eq!(current["tags"], json!(["before"]));
    let history = agent.call("tie_history", json!({"id_or_title":id}));
    assert_eq!(history.as_array().unwrap().len(), 2);
    let bad_revision = history.as_array().unwrap().iter().find(|entry| entry["id"] != revision).unwrap()["id"].as_str().unwrap();
    let bad = agent.call("tie_revision_get", json!({"id_or_title":id, "revisionId":bad_revision}));
    assert!(bad["markdown"].as_str().unwrap().contains("Broken."));
    let difference = agent.call("tie_diff", json!({"id_or_title":id, "revisionId":revision, "compareTo":bad_revision}));
    assert_eq!(difference["toRevisionId"], bad_revision);
    assert_eq!(difference["changed"], true);
    let identical = agent.call("tie_diff", json!({"id_or_title":id, "revisionId":revision, "compareTo":revision}));
    assert_eq!(identical["changed"], false);
    assert_eq!(identical["metadataChanges"], json!([]));
    assert_eq!(identical["diff"], "");
    let audit = agent.call("tie_changes", json!({"id_or_title":id}));
    let event = audit["entries"].as_array().unwrap().iter().find(|event| event["type"] == "restore").unwrap();
    assert_eq!(event["type"], "restore");
    assert_eq!(event["actor"], "Restore tester");
    assert_eq!(event["pageId"], id);
    assert_eq!(event["revisionId"], revision);
}

#[test]
fn rejected_history_requests_do_not_modify_page_revisions_or_restore_audit() {
    let mut agent = Agent::start();
    let saved = agent.call("tie_write", json!({"title":"Boundary", "markdown":"old body"}));
    let id = saved["page"]["id"].as_str().unwrap().to_owned();
    agent.call("tie_write", json!({"pageId":id, "markdown":"current body"}));
    let history = agent.call("tie_history", json!({"id_or_title":id}));
    let revision = history[0]["id"].as_str().unwrap();
    let before = agent.call("tie_get", json!({"id_or_title":id}));
    let audit_path = agent.workspace.root().join(".tie/reviews").join(format!("{id}.json"));
    let audit_before = fs::read(&audit_path).unwrap();
    agent.rejected("tie_restore", json!({"id_or_title":id, "revisionId":revision, "expectedUpdatedAt":"stale"}));
    for invalid in ["../other/123", "C:\\history", "other\\123"] {
        agent.rejected("tie_revision_get", json!({"id_or_title":id,"revisionId":invalid}));
        agent.rejected("tie_diff", json!({"id_or_title":id,"revisionId":revision,"compareTo":invalid}));
        agent.rejected("tie_restore", json!({"id_or_title":id,"revisionId":invalid}));
    }
    let other = agent.workspace.write_page(WritePageInput { title:Some("Other".into()), ..Default::default() }).unwrap();
    let foreign = agent.workspace.get_by_id(&other.page.id).unwrap().unwrap();
    let foreign_path = agent.workspace.root().join(".tie/history").join(&id).join("foreign.md");
    fs::write(&foreign_path, tie_local::frontmatter(&foreign)).unwrap();
    agent.rejected("tie_revision_get", json!({"id_or_title":id,"revisionId":"foreign"}));
    agent.rejected("tie_history", json!({"id_or_title":id}));
    agent.rejected("tie_restore", json!({"id_or_title":id,"revisionId":"foreign"}));
    fs::remove_file(foreign_path).unwrap();
    assert_eq!(agent.call("tie_get", json!({"id_or_title":id})), before);
    assert_eq!(agent.call("tie_history", json!({"id_or_title":id})), history);
    assert_eq!(fs::read(audit_path).unwrap(), audit_before);
}

#[test]
fn history_defaults_to_twenty_and_validates_explicit_limits() {
    let mut agent = Agent::start();
    let saved = agent.call("tie_write", json!({"title":"Limits", "markdown":"version 0"}));
    let id = saved["page"]["id"].as_str().unwrap().to_owned();
    for version in 1..=23 {
        agent.call("tie_write", json!({"pageId":id,"markdown":format!("version {version}")}));
    }
    assert_eq!(agent.call("tie_history", json!({"id_or_title":id})).as_array().unwrap().len(), 20);
    assert_eq!(agent.call("tie_history", json!({"id_or_title":id,"limit":80})).as_array().unwrap().len(), 23);
    let latest = agent.call("tie_history", json!({"id_or_title":id,"limit":1}));
    assert_eq!(latest.as_array().unwrap().len(), 1);
    let revision = agent.call("tie_revision_get", json!({"id_or_title":id,"revisionId":latest[0]["id"]}));
    assert!(revision["markdown"].as_str().unwrap().contains("version 22"));
    for limit in [json!(0), json!(81), json!(-1), json!("1")] {
        agent.rejected("tie_history", json!({"id_or_title":id,"limit":limit}));
    }
}

#[test]
fn ambiguous_history_titles_fail_without_changing_either_page() {
    let mut agent = Agent::start();
    let first = agent.call("tie_write", json!({"title":"Shared", "markdown":"first body"}));
    let first_id = first["page"]["id"].as_str().unwrap();
    let second = agent.call("tie_write", json!({"title":"SHARED", "markdown":"second body"}));
    let second_id = second["page"]["id"].as_str().unwrap();
    agent.call("tie_write", json!({"pageId":first_id,"markdown":"modified first body"}));
    let history = agent.call("tie_history", json!({"id_or_title":first_id}));
    let revision = history[0]["id"].as_str().unwrap();
    let first_before = agent.call("tie_get", json!({"id_or_title":first_id}));
    let second_before = agent.call("tie_get", json!({"id_or_title":second_id}));
    for name in ["tie_history", "tie_revision_get", "tie_diff", "tie_restore"] {
        agent.rejected(name, json!({"id_or_title":"Shared", "revisionId":revision}));
    }
    assert_eq!(agent.call("tie_get", json!({"id_or_title":first_id})), first_before);
    assert_eq!(agent.call("tie_get", json!({"id_or_title":second_id})), second_before);
    assert_eq!(agent.call("tie_history", json!({"id_or_title":first_id})), history);
    assert_eq!(agent.call("tie_history", json!({"id_or_title":second_id})), json!([]));
}
