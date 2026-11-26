use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tie_local::{backend_session, LocalWorkspace, WritePageInput};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("tie-mcp-routing-{}", tie_local::new_page_id()));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn workspace(&self) -> LocalWorkspace {
        LocalWorkspace::init(self.0.join("workspace"), "src_test").unwrap()
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone)]
struct HttpRequest {
    start: String,
    headers: Vec<(String, String)>,
    body: Value,
}

struct HttpServer {
    endpoint: String,
    healthy: Arc<AtomicBool>,
    received: Arc<Mutex<Vec<HttpRequest>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl HttpServer {
    fn start(healthy: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(AtomicBool::new(healthy));
        let current_state = state.clone();
        let received = Arc::new(Mutex::new(Vec::new()));
        let requests = received.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("accept: {error}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut start = String::new();
                reader.read_line(&mut start).unwrap();
                let mut headers = Vec::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    let (name, value) = line.split_once(':').unwrap();
                    headers.push((name.to_ascii_lowercase(), value.trim().to_owned()));
                }
                let length = headers
                    .iter()
                    .find(|(name, _)| name == "content-length")
                    .map(|(_, value)| value.parse::<usize>().unwrap())
                    .unwrap_or(0);
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let body = if body.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&body).unwrap()
                };
                let request = HttpRequest {
                    start: start.trim().into(),
                    headers,
                    body,
                };
                requests.lock().unwrap().push(request.clone());
                let (status, response) = if request.start.starts_with("GET /health ") {
                    if current_state.load(Ordering::Relaxed) {
                        (
                            200,
                            json!({"ok": true, "mcp": {"enabled": true, "running": true}}),
                        )
                    } else {
                        (503, json!({"ok": false}))
                    }
                } else {
                    assert!(request.start.starts_with("POST /mcp "));
                    let result = match request.body["method"].as_str().unwrap() {
                        "initialize" => {
                            json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "test-server", "version": "1"}})
                        }
                        "ping" => json!({}),
                        "tools/call" => {
                            let value = match request.body["params"]["name"].as_str().unwrap() {
                                "tie_doctor" => {
                                    json!({"ok": true, "transport": "http", "workspace": "/server/workspace"})
                                }
                                "tie_get" => {
                                    json!({"id": "pg_remote", "title": "Remote page", "markdown": "# Remote page\n\nRead through HTTP\n"})
                                }
                                "tie_history" => json!([{"id":"revision_remote", "savedAt":"2026-11-26T00:00:00Z", "title":"Remote revision"}]),
                                "tie_revision_get" => json!({"id":"pg_remote", "title":"Remote revision", "markdown":"server history"}),
                                "tie_diff" => json!({"pageId":"pg_remote", "fromRevisionId":"revision_remote", "toRevisionId":"current", "changed":true, "metadataChanges":[], "diff":"server diff"}),
                                "tie_restore" => json!({"restored":true, "revisionId":"revision_remote", "page":{"id":"pg_remote", "title":"Restored on server"}}),
                                "tie_secret_search" => json!([{"secretRef":"secret://sec_remote", "name":"Server credential"}]),
                                "tie_secret_use" => json!({"ok":true,"httpStatus":204,"eventId":"use_remote"}),
                                "tie_secret_usage" => json!([{"id":"use_remote","status":"succeeded"}]),
                                other => panic!("unexpected remote tool: {other}"),
                            };
                            json!({"isError": false, "content": [{"type": "text", "text": serde_json::to_string(&value).unwrap()}]})
                        }
                        other => panic!("unexpected remote method: {other}"),
                    };
                    (
                        200,
                        json!({"jsonrpc": "2.0", "id": request.body["id"], "result": result}),
                    )
                };
                let bytes = serde_json::to_vec(&response).unwrap();
                write!(stream, "HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).unwrap();
                stream.write_all(&bytes).unwrap();
            }
        });
        Self {
            endpoint,
            healthy: state,
            received,
            stop,
            thread: Some(thread),
        }
    }
}

impl Drop for HttpServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}

struct Agent {
    child: Child,
    input: ChildStdin,
    output: Receiver<Value>,
    reader: Option<JoinHandle<()>>,
    next_id: u64,
}

impl Agent {
    fn start(directory: &TestDirectory, workspace: Option<&Path>, env: &[(&str, &str)]) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_tie-cli"));
        command
            .arg("mcp")
            .current_dir(&directory.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for key in [
            "TIE_WORKSPACE",
            "TIE_SOURCE_ID",
            "TIE_APP_DATA",
            "TIE_MCP_URL",
            "TIE_MCP_TOKEN",
            "TIE_MCP_TOKEN_FILE",
            "TIE_MCP_WORKSPACE",
            "TIE_MCP_VIA",
        ] {
            command.env_remove(key);
        }
        command
            .env("TIE_APP_DATA", directory.0.join("app-data"))
            .env("TIE_ACTOR", "Integration test");
        if let Some(workspace) = workspace {
            command.env("TIE_WORKSPACE", workspace);
        }
        for (key, value) in env {
            command.env(key, value);
        }
        let mut child = command.spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, output) = mpsc::channel();
        let reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let line = line.unwrap();
                if sender.send(serde_json::from_str(&line).unwrap()).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            output,
            reader: Some(reader),
            next_id: 0,
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let message =
            json!({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params});
        writeln!(self.input, "{message}").unwrap();
        self.input.flush().unwrap();
        let response = self
            .output
            .recv_timeout(Duration::from_secs(10))
            .expect("CLI response");
        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["id"], self.next_id);
        assert!(response.get("error").is_none(), "{response}");
        response
    }

    fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({"name": name, "arguments": arguments}))
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.reader.take().unwrap().join().unwrap();
    }
}

fn tool_value(response: &Value) -> Value {
    serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

fn bind(workspace: &LocalWorkspace, server: &HttpServer) {
    fs::create_dir_all(workspace.root().join(".tie")).unwrap();
    fs::write(
        workspace.root().join(".tie/sync.json"),
        json!({
            "engine": "backend", "url": server.endpoint, "workspaceId": "workspace-test"
        })
        .to_string(),
    )
    .unwrap();
}

#[test]
fn outage_blocks_content_until_user_confirms_and_keeps_failed_sync_write() {
    let directory = TestDirectory::new();
    let workspace = directory.workspace();
    let original = workspace
        .write_page(WritePageInput {
            title: Some("Original local page".into()),
            markdown: Some("original content".into()),
            ..Default::default()
        })
        .unwrap();
    let server = HttpServer::start(false);
    bind(&workspace, &server);
    let mut agent = Agent::start(
        &directory,
        Some(workspace.root()),
        &[("TIE_MCP_TOKEN", "test-user-token")],
    );
    let initialize = agent.request("initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}));
    assert!(initialize["result"]["instructions"]
        .as_str()
        .unwrap()
        .contains("用户"));
    let tools = agent.request("tools/list", json!({}));
    assert!(tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["name"] == "tie_connection"));

    let blocked = agent.call("tie_get", json!({"id_or_title": original.page.id}));
    assert_eq!(blocked["result"]["isError"], true);
    let blocked_value = tool_value(&blocked);
    assert_eq!(blocked_value["code"], "HTTP_FALLBACK_CONFIRMATION_REQUIRED");
    let confirmation = blocked_value["confirmationId"].as_str().unwrap().to_owned();
    let write = agent.call(
        "tie_write",
        json!({"title": "Blocked write", "markdown": "must not save"}),
    );
    assert_eq!(write["result"]["isError"], true);
    assert_eq!(tool_value(&write)["confirmationId"], confirmation);
    assert_eq!(workspace.list_pages(false).unwrap().len(), 1);

    for args in [
        json!({"action": "confirm_local", "confirmationId": confirmation}),
        json!({"action": "confirm_local", "confirmationId": confirmation, "confirmed": false}),
        json!({"action": "confirm_local", "confirmationId": "wrong-id", "confirmed": true}),
    ] {
        assert_eq!(
            agent.call("tie_connection", args)["result"]["isError"],
            true
        );
    }
    assert_eq!(
        agent.call("tie_get", json!({"id_or_title": original.page.id}))["result"]["isError"],
        true
    );
    let confirmed = agent.call(
        "tie_connection",
        json!({"action": "confirm_local", "confirmationId": confirmation, "confirmed": true}),
    );
    assert_eq!(confirmed["result"]["isError"], false);
    assert_eq!(
        tool_value(&agent.call("tie_get", json!({"id_or_title": original.page.id})))["id"],
        original.page.id
    );

    let saved = agent.call(
        "tie_write",
        json!({"title": "Confirmed local write", "markdown": "kept after sync failure"}),
    );
    assert_eq!(saved["result"]["isError"], false);
    let value = tool_value(&saved);
    assert_eq!(value["sync"]["state"], "pending");
    let page = workspace
        .get_by_id(value["page"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert!(page.markdown.contains("kept after sync failure"));
    assert_eq!(workspace.list_pages(false).unwrap().len(), 2);
    assert!(server
        .received
        .lock()
        .unwrap()
        .iter()
        .all(|request| request.start.starts_with("GET /health ")));
    assert!(!directory.0.join("app-data/backend-session.json").exists());
}

#[test]
fn recovered_http_revokes_local_permission_before_the_next_outage() {
    let directory = TestDirectory::new();
    let workspace = directory.workspace();
    let server = HttpServer::start(false);
    bind(&workspace, &server);
    let mut agent = Agent::start(
        &directory,
        Some(workspace.root()),
        &[("TIE_MCP_TOKEN", "test-user-token")],
    );
    let blocked = tool_value(&agent.call("tie_doctor", json!({})));
    let first_id = blocked["confirmationId"].as_str().unwrap().to_owned();
    agent.call(
        "tie_connection",
        json!({"action": "confirm_local", "confirmationId": first_id, "confirmed": true}),
    );
    assert_eq!(
        tool_value(&agent.call("tie_doctor", json!({})))["transport"],
        "local"
    );

    server.healthy.store(true, Ordering::Relaxed);
    assert_eq!(
        tool_value(&agent.call("tie_doctor", json!({})))["transport"],
        "http"
    );
    server.healthy.store(false, Ordering::Relaxed);
    let blocked = agent.call("tie_doctor", json!({}));
    assert_eq!(blocked["result"]["isError"], true);
    let blocked = tool_value(&blocked);
    assert_eq!(blocked["code"], "HTTP_FALLBACK_CONFIRMATION_REQUIRED");
    assert_ne!(blocked["confirmationId"], first_id);
    assert_eq!(
        agent.call(
            "tie_connection",
            json!({"action": "confirm_local", "confirmationId": first_id, "confirmed": true})
        )["result"]["isError"],
        true
    );
}

#[test]
fn token_only_agent_reads_http_without_an_app_session_or_workspace() {
    let directory = TestDirectory::new();
    let server = HttpServer::start(true);
    let mut agent = Agent::start(
        &directory,
        None,
        &[
            ("TIE_MCP_URL", &server.endpoint),
            ("TIE_MCP_TOKEN", "test-user-token"),
        ],
    );
    let status = tool_value(&agent.call("tie_connection", json!({"action": "status"})));
    assert_eq!(status["transport"], "http");
    assert_eq!(status["authorization"], "mcp-token");
    let page = agent.call("tie_get", json!({"id_or_title": "pg_remote"}));
    assert_eq!(page["result"]["isError"], false);
    assert_eq!(tool_value(&page)["id"], "pg_remote");
    assert!(tool_value(&page)["markdown"]
        .as_str()
        .unwrap()
        .contains("Read through HTTP"));
    assert!(!directory.0.join("workspace").exists());
    assert!(!directory.0.join("app-data/backend-session.json").exists());
    let requests = server.received.lock().unwrap();
    assert!(requests.len() >= 4);
    for request in requests.iter() {
        let auth = request
            .headers
            .iter()
            .find(|(name, _)| name == "authorization");
        if request.start.starts_with("GET /health ") {
            assert!(auth.is_none());
        } else {
            assert_eq!(auth.unwrap().1, "Bearer test-user-token");
            assert!(!request
                .headers
                .iter()
                .any(|(name, _)| name == "x-tie-workspace"));
        }
    }
}

#[test]
fn saved_app_login_is_used_without_a_user_mcp_token() {
    let directory = TestDirectory::new();
    let workspace = directory.workspace();
    let server = HttpServer::start(true);
    bind(&workspace, &server);
    backend_session::write_session_at(
        &directory.0.join("app-data"),
        &backend_session::BackendSession {
            endpoint: server.endpoint.clone(),
            access_token: "test-app-access".into(),
            refresh_token: String::new(),
            access_expires_at: String::new(),
            user_id: "test-user".into(),
            email: "test@example.invalid".into(),
            name: "Test".into(),
        },
    )
    .unwrap();
    let mut agent = Agent::start(&directory, Some(workspace.root()), &[]);
    let status = tool_value(&agent.call("tie_connection", json!({"action": "status"})));
    assert_eq!(status["transport"], "http");
    assert_eq!(status["authorization"], "login-session");
    assert_eq!(
        tool_value(&agent.call("tie_get", json!({"id_or_title": "pg_remote"})))["id"],
        "pg_remote"
    );
    let requests = server.received.lock().unwrap();
    for request in requests
        .iter()
        .filter(|request| request.start.starts_with("POST "))
    {
        assert!(request
            .headers
            .iter()
            .any(|(name, value)| name == "authorization" && value == "Bearer test-app-access"));
        assert!(request
            .headers
            .iter()
            .any(|(name, value)| name == "x-tie-workspace" && value == "workspace-test"));
    }
}

#[test]
fn local_only_mutations_report_sync_skipped() {
    let directory = TestDirectory::new();
    let workspace = directory.workspace();
    let mut agent = Agent::start(&directory, Some(workspace.root()), &[]);
    let saved = agent.call(
        "tie_write",
        json!({"title": "Local only", "markdown": "local body"}),
    );
    assert_eq!(saved["result"]["isError"], false);
    let value = tool_value(&saved);
    assert_eq!(value["sync"]["state"], "skipped");
    assert!(workspace
        .get_by_id(value["page"]["id"].as_str().unwrap())
        .unwrap()
        .is_some());

    let file = directory.0.join("attachment.txt");
    fs::write(&file, "attachment body").unwrap();
    let ingested = agent.call("tie_file_ingest", json!({"path": file, "mode": "copy"}));
    assert_eq!(ingested["result"]["isError"], false);
    assert_eq!(tool_value(&ingested)["sync"]["state"], "skipped");
    assert_eq!(workspace.files().list(None, None, 10).unwrap().len(), 1);

    let source = LocalWorkspace::init(directory.0.join("import-source"), "src_import").unwrap();
    let page = source
        .write_page(WritePageInput {
            title: Some("Imported page".into()),
            markdown: Some("import body".into()),
            ..Default::default()
        })
        .unwrap();
    let bundle = directory.0.join("exported");
    source
        .export_closure(
            &page.page.id,
            &tie_local::ExportOptions {
                out: Some(bundle.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    let imported = agent.call("tie_import", json!({"path": bundle}));
    assert_eq!(imported["result"]["isError"], false);
    assert_eq!(tool_value(&imported)["sync"]["state"], "skipped");
    assert_eq!(tool_value(&imported)["created"], 1);
    assert!(workspace.get_by_id(&page.page.id).unwrap().is_some());
}

#[test]
fn backend_http_child_never_starts_reverse_http_or_sync() {
    let directory = TestDirectory::new();
    let workspace = directory.workspace();
    let server = HttpServer::start(true);
    bind(&workspace, &server);
    let mut agent = Agent::start(
        &directory,
        Some(workspace.root()),
        &[
            ("TIE_MCP_VIA", "http"),
            ("TIE_MCP_TOKEN", "test-user-token"),
        ],
    );
    let saved = agent.call(
        "tie_write",
        json!({"title": "Backend write", "markdown": "server body"}),
    );
    assert_eq!(saved["result"]["isError"], false);
    let value = tool_value(&saved);
    assert!(value.get("sync").is_none());
    assert!(workspace
        .get_by_id(value["page"]["id"].as_str().unwrap())
        .unwrap()
        .is_some());
    let page_id = value["page"]["id"].as_str().unwrap();
    agent.call("tie_write", json!({"pageId":page_id,"markdown":"changed server body"}));
    let history = tool_value(&agent.call("tie_history", json!({"id_or_title":page_id})));
    let restored = agent.call("tie_restore", json!({"id_or_title":page_id,"revisionId":history[0]["id"]}));
    assert_eq!(restored["result"]["isError"], false);
    assert!(tool_value(&restored).get("sync").is_none());
    assert!(workspace.get_by_id(page_id).unwrap().unwrap().markdown.contains("server body"));
    assert!(!workspace.get_by_id(page_id).unwrap().unwrap().markdown.contains("changed"));
    assert!(server.received.lock().unwrap().is_empty());
}

#[test]
fn remote_history_tools_use_http_without_a_local_workspace_or_reverse_sync() {
    let directory = TestDirectory::new();
    let server = HttpServer::start(true);
    let mut agent = Agent::start(&directory, None, &[
        ("TIE_MCP_URL", server.endpoint.as_str()),
        ("TIE_MCP_TOKEN", "test-user-token"),
    ]);
    let arguments = json!({"id_or_title":"pg_remote","revisionId":"revision_remote"});
    let history = tool_value(&agent.call("tie_history", json!({"id_or_title":"pg_remote"})));
    assert_eq!(history[0]["id"], "revision_remote");
    let revision = tool_value(&agent.call("tie_revision_get", arguments.clone()));
    assert_eq!(revision["markdown"], "server history");
    let difference = tool_value(&agent.call("tie_diff", arguments.clone()));
    assert_eq!(difference["diff"], "server diff");
    let restored = tool_value(&agent.call("tie_restore", arguments));
    assert_eq!(restored["restored"], true);
    assert_eq!(restored["page"]["id"], "pg_remote");
    assert!(restored.get("sync").is_none());
    let received = server.received.lock().unwrap();
    let names = received.iter().filter(|request| request.body["method"] == "tools/call")
        .map(|request| request.body["params"]["name"].as_str().unwrap()).collect::<Vec<_>>();
    assert_eq!(names, vec!["tie_history", "tie_revision_get", "tie_diff", "tie_restore"]);
    assert!(!directory.0.join("pages").exists());
}

#[test]
fn vault_tools_use_http_without_local_support() {
    let directory = TestDirectory::new();
    let server = HttpServer::start(true);
    let mut agent = Agent::start(&directory, None, &[
        ("TIE_MCP_URL", server.endpoint.as_str()),
        ("TIE_MCP_TOKEN", "test-user-token"),
    ]);
    let secrets = tool_value(&agent.call("tie_secret_search", json!({"query":"Server"})));
    assert_eq!(secrets[0]["secretRef"], "secret://sec_remote");
    let used = tool_value(&agent.call("tie_secret_use", json!({"secretRef":secrets[0]["secretRef"]})));
    assert_eq!(used["httpStatus"], 204);
    assert!(used.get("sync").is_none());
    let usage = tool_value(&agent.call("tie_secret_usage", json!({})));
    assert_eq!(usage[0]["status"], "succeeded");
    assert!(!directory.0.join("pages").exists());
}

#[test]
fn vault_never_falls_back_even_after_content_fallback_is_confirmed() {
    let directory = TestDirectory::new();
    let workspace = directory.workspace();
    let server = HttpServer::start(false);
    bind(&workspace, &server);
    let mut agent = Agent::start(&directory, Some(workspace.root()), &[("TIE_MCP_TOKEN", "test-user-token")]);
    let status = tool_value(&agent.call("tie_connection", json!({})));
    agent.call("tie_connection", json!({"action":"confirm_local", "confirmed":true, "confirmationId":status["confirmationId"]}));
    let plain = workspace.root().join("pages/unregistered.md");
    fs::write(plain, "# Unregistered\n\nDo not open local files.\n").unwrap();
    for name in ["tie_secret_search", "tie_secret_use", "tie_secret_usage"] {
        let blocked = agent.call(name, json!({"secretRef":"secret://sec_local"}));
        assert_eq!(blocked["result"]["isError"], true);
        assert!(blocked["result"]["content"][0]["text"].as_str().unwrap().contains("未降级本地"));
    }
    assert!(!workspace.root().join(".tie/meta").exists());
}

#[test]
fn startup_and_failed_http_requests_do_not_adopt_unregistered_markdown() {
    let directory = TestDirectory::new();
    let workspace = directory.workspace();
    let plain = workspace.root().join("pages/plain.md");
    let original = "# Await confirmation\n\nMust stay unregistered\n";
    fs::write(&plain, original).unwrap();
    let server = HttpServer::start(false);
    bind(&workspace, &server);
    let meta = workspace.root().join(".tie/meta");
    assert!(!meta.exists());
    let mut agent = Agent::start(
        &directory,
        Some(workspace.root()),
        &[("TIE_MCP_TOKEN", "test-user-token")],
    );
    agent.request("initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}));
    assert!(
        !meta.exists(),
        "initialization must not adopt local Markdown"
    );
    agent.request("tools/list", json!({}));
    assert!(
        !meta.exists(),
        "tool discovery must not adopt local Markdown"
    );

    let blocked = agent.call("tie_get", json!({"id_or_title": "Await confirmation"}));
    assert_eq!(blocked["result"]["isError"], true);
    let blocked_value = tool_value(&blocked);
    assert_eq!(blocked_value["code"], "HTTP_FALLBACK_CONFIRMATION_REQUIRED");
    assert!(!meta.exists(), "blocked read must not adopt local Markdown");
    let write = agent.call(
        "tie_write",
        json!({"title": "Blocked", "markdown": "must not save"}),
    );
    assert_eq!(write["result"]["isError"], true);
    assert!(
        !meta.exists(),
        "blocked write must not adopt local Markdown"
    );
    assert_eq!(fs::read_to_string(&plain).unwrap(), original);
    assert_eq!(fs::read_dir(workspace.pages_dir()).unwrap().count(), 1);

    let confirmed = agent.call("tie_connection", json!({"action": "confirm_local", "confirmationId": blocked_value["confirmationId"], "confirmed": true}));
    assert_eq!(confirmed["result"]["isError"], false);
    let read = agent.call("tie_get", json!({"id_or_title": "Await confirmation"}));
    assert_eq!(read["result"]["isError"], false);
    assert_eq!(tool_value(&read)["markdown"], original);
    assert_eq!(fs::read_dir(meta).unwrap().count(), 1);
    assert_eq!(fs::read_to_string(&plain).unwrap(), original);
}

#[test]
fn outage_gates_host_file_tools_without_forwarding_paths_to_http() {
    let directory = TestDirectory::new();
    let workspace = directory.workspace();
    let original = workspace
        .write_page(WritePageInput {
            title: Some("Original page".into()),
            markdown: Some("local content".into()),
            ..Default::default()
        })
        .unwrap();
    let source = LocalWorkspace::init(directory.0.join("import-source"), "src_import").unwrap();
    let imported_page = source
        .write_page(WritePageInput {
            title: Some("Imported page".into()),
            markdown: Some("import content".into()),
            ..Default::default()
        })
        .unwrap();
    let bundle = directory.0.join("import-bundle");
    source
        .export_closure(
            &imported_page.page.id,
            &tie_local::ExportOptions {
                out: Some(bundle.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    let attachment = directory.0.join("private-attachment.txt");
    fs::write(&attachment, "private file bytes").unwrap();
    let exported = directory.0.join("blocked-export");
    let server = HttpServer::start(false);
    bind(&workspace, &server);
    let mut agent = Agent::start(
        &directory,
        Some(workspace.root()),
        &[("TIE_MCP_TOKEN", "test-user-token")],
    );
    let calls = [
        ("tie_import", json!({"path": bundle})),
        (
            "tie_file_ingest",
            json!({"path": attachment, "mode": "copy"}),
        ),
        (
            "tie_export",
            json!({"page": original.page.id, "out": exported}),
        ),
    ];
    let mut confirmation = Value::Null;
    for (name, args) in &calls {
        let blocked = agent.call(name, args.clone());
        assert_eq!(blocked["result"]["isError"], true, "{name}: {blocked}");
        let value = tool_value(&blocked);
        assert_eq!(value["code"], "HTTP_FALLBACK_CONFIRMATION_REQUIRED");
        if confirmation.is_null() {
            confirmation = value["confirmationId"].clone();
        } else {
            assert_eq!(value["confirmationId"], confirmation);
        }
    }
    assert_eq!(
        fs::read_dir(workspace.root().join(".tie/meta"))
            .unwrap()
            .count(),
        1
    );
    assert_eq!(fs::read_dir(workspace.pages_dir()).unwrap().count(), 1);
    assert!(!workspace.root().join(".tie/files").exists());
    assert!(!exported.exists());
    assert_eq!(
        fs::read_to_string(&attachment).unwrap(),
        "private file bytes"
    );

    let confirmed = agent.call(
        "tie_connection",
        json!({"action": "confirm_local", "confirmationId": confirmation, "confirmed": true}),
    );
    assert_eq!(confirmed["result"]["isError"], false);
    for (name, args) in &calls {
        let response = agent.call(name, args.clone());
        assert_eq!(response["result"]["isError"], false, "{name}: {response}");
        if *name != "tie_export" {
            assert_eq!(tool_value(&response)["sync"]["state"], "pending");
        }
    }
    assert!(workspace
        .get_by_id(&imported_page.page.id)
        .unwrap()
        .is_some());
    assert_eq!(workspace.files().list(None, None, 10).unwrap().len(), 1);
    assert!(exported.is_dir());
    assert!(server
        .received
        .lock()
        .unwrap()
        .iter()
        .all(|request| request.start.starts_with("GET /health ")));
}
