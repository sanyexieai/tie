use reqwest::{blocking::Client, redirect::Policy, StatusCode, Url};
use serde_json::Value;
use std::{cell::Cell, fs, path::Path, time::Duration};
use tie_cli::backend_sync;
use tie_local::backend_session::{self, BackendSession};

pub struct HttpTransport {
    endpoint: String,
    workspace_id: Option<String>,
    token: Option<String>,
    has_session: bool,
    auth_kind: Cell<&'static str>,
    health_client: Client,
    request_client: Client,
}

impl HttpTransport {
    pub fn from_workspace(root: Option<&Path>) -> Result<Option<Self>, String> {
        let explicit_url = env_value("TIE_MCP_URL")
            .map(|url| normalize_endpoint(&url))
            .transpose()?;
        let binding = read_binding(root)?;
        let token = env_value("TIE_MCP_TOKEN");
        let token_file = env_value("TIE_MCP_TOKEN_FILE");
        let Some(endpoint) = explicit_url.or_else(|| binding.as_ref().map(|(url, _)| url.clone()))
        else {
            if token.is_some() || token_file.is_some() {
                return Err("MCP_CONFIG_REQUIRED: 已提供 MCP token，请同时通过 TIE_MCP_URL 指定服务器地址。".to_owned());
            }
            return Ok(None);
        };
        let workspace_id = env_value("TIE_MCP_WORKSPACE").or_else(|| {
            binding.as_ref().and_then(|(url, id)| {
                backend_sync::same_backend_endpoint(&endpoint, url).then(|| id.clone())
            })
        });
        let token = match token {
            Some(token) => Some(token),
            None => token_file
                .map(|path| read_token_file(Path::new(&path)))
                .transpose()?,
        };
        let session = backend_session::read_session().ok().flatten();
        let has_session = usable_session(session.as_ref(), &endpoint, workspace_id.as_deref());
        Self::new(endpoint, workspace_id, token, has_session).map(Some)
    }

    fn new(
        endpoint: String,
        workspace_id: Option<String>,
        token: Option<String>,
        has_session: bool,
    ) -> Result<Self, String> {
        // Redirects must never carry credentials to a different backend.
        let client = |timeout| {
            Client::builder()
                .redirect(Policy::none())
                .timeout(timeout)
                .build()
                .map_err(|_| "MCP_HTTP_CLIENT: 无法创建 HTTP 客户端".to_owned())
        };
        let auth_kind = if has_session {
            "login-session"
        } else if token.is_some() {
            "mcp-token"
        } else {
            "required"
        };
        Ok(Self {
            endpoint,
            workspace_id,
            token,
            has_session,
            auth_kind: Cell::new(auth_kind),
            health_client: client(Duration::from_secs(3))?,
            request_client: client(Duration::from_secs(25))?,
        })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn auth_kind(&self) -> &str {
        self.auth_kind.get()
    }

    pub fn request(&self, message: &Value) -> Result<Value, String> {
        self.check_health()?;
        if self.has_session {
            if let Ok(session) = backend_sync::ensure_session(false) {
                if usable_session(Some(&session), &self.endpoint, self.workspace_id.as_deref()) {
                    let result =
                        self.post(message, &session.access_token, self.workspace_id.as_deref());
                    if !matches!(result, Err(ref error) if error.starts_with("MCP_AUTH_REJECTED")) {
                        return result;
                    }
                    // Refresh only the app login, never a user-issued MCP token.
                    if let Ok(session) = backend_sync::ensure_session(true) {
                        if usable_session(
                            Some(&session),
                            &self.endpoint,
                            self.workspace_id.as_deref(),
                        ) {
                            self.auth_kind.set("login-session");
                            let result = self.post(
                                message,
                                &session.access_token,
                                self.workspace_id.as_deref(),
                            );
                            if !matches!(result, Err(ref error) if error.starts_with("MCP_AUTH_REJECTED"))
                            {
                                return result;
                            }
                        }
                    }
                }
            }
        }
        if let Some(token) = &self.token {
            self.auth_kind.set("mcp-token");
            return self.post(message, token, None);
        }
        self.auth_kind.set("required");
        Err(if self.has_session {
            "MCP_AUTH_REQUIRED: 本地登录会话不可用。请重新登录，或由用户提供此服务器的 MCP token。"
        } else {
            "MCP_AUTH_REQUIRED: 没有可用的本地登录会话。请由用户提供 MCP token；可通过 TIE_MCP_TOKEN 或私有的 TIE_MCP_TOKEN_FILE 提供。"
        }.to_owned())
    }

    fn check_health(&self) -> Result<(), String> {
        let response = self
            .health_client
            .get(format!("{}/health", self.endpoint))
            .send()
            .map_err(|_| {
                "MCP_HEALTH_UNREACHABLE: 无法连接服务器健康检查，尚未切换到本地。".to_owned()
            })?;
        if !response.status().is_success() {
            return Err(format!(
                "MCP_HEALTH_STATUS: 服务器健康检查返回 HTTP {}，尚未切换到本地。",
                response.status().as_u16()
            ));
        }
        let health: Value = response
            .json()
            .map_err(|_| "MCP_HEALTH_INVALID: 服务器健康检查响应不是有效 JSON。".to_owned())?;
        if health.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err("MCP_HEALTH_FAILED: 服务器未通过健康检查。".to_owned());
        }
        if health.pointer("/mcp/enabled").and_then(Value::as_bool) != Some(true) {
            return Err("MCP_HEALTH_DISABLED: 服务器尚未开启 MCP HTTP。".to_owned());
        }
        if health.pointer("/mcp/running").and_then(Value::as_bool) != Some(true) {
            return Err("MCP_HEALTH_STOPPED: 服务器 MCP HTTP 未正常运行。".to_owned());
        }
        if let Some(url) = health.pointer("/mcp/url").and_then(Value::as_str) {
            let advertised = normalize_endpoint(url)?;
            if !backend_sync::same_backend_endpoint(&advertised, &self.endpoint) {
                return Err(
                    "MCP_HEALTH_TARGET: 服务器报告了不同的 MCP 地址；未向该地址发送凭据。"
                        .to_owned(),
                );
            }
        }
        Ok(())
    }

    fn post(
        &self,
        message: &Value,
        token: &str,
        workspace_id: Option<&str>,
    ) -> Result<Value, String> {
        let mut request = self
            .request_client
            .post(format!("{}/mcp", self.endpoint))
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-06-18")
            .header("x-tie-origin", tie_local::changes::origin_header(&tie_local::changes::current_origin())?)
            .bearer_auth(token)
            .json(message);
        if let Some(workspace_id) = workspace_id {
            request = request.header("x-tie-workspace", workspace_id);
        }
        let response = request.send().map_err(|_| {
            "MCP_HTTP_UNREACHABLE: HTTP MCP 请求失败或超时，尚未切换到本地。".to_owned()
        })?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(
                "MCP_AUTH_REJECTED: 服务器拒绝了授权，请检查登录会话或用户提供的 MCP token。"
                    .to_owned(),
            );
        }
        if !status.is_success() {
            return Err(format!(
                "MCP_HTTP_STATUS: HTTP MCP 返回 HTTP {}，尚未切换到本地。",
                status.as_u16()
            ));
        }
        if message.get("id").is_none() && status == StatusCode::ACCEPTED {
            return Ok(Value::Null);
        }
        let response: Value = response
            .json()
            .map_err(|_| "MCP_HTTP_INVALID: HTTP MCP 未返回有效 JSON-RPC 响应。".to_owned())?;
        if response.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
            || response.get("id") != message.get("id")
            || (response.get("result").is_none() && response.get("error").is_none())
        {
            return Err("MCP_HTTP_INVALID: HTTP MCP 的 JSON-RPC 响应与请求不匹配。".to_owned());
        }
        Ok(response)
    }
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn read_binding(root: Option<&Path>) -> Result<Option<(String, String)>, String> {
    let Some(root) = root else { return Ok(None) };
    let path = root.join(".tie/sync.json");
    if !path.is_file() {
        return Ok(None);
    }
    let data = fs::read_to_string(path)
        .map_err(|_| "MCP_CONFIG_INVALID: 无法读取工作区服务器绑定。".to_owned())?;
    let value: Value = serde_json::from_str(&data)
        .map_err(|_| "MCP_CONFIG_INVALID: 工作区服务器绑定不是有效 JSON。".to_owned())?;
    match value.get("engine").and_then(Value::as_str) {
        Some("backend") => {}
        Some("git") => return Ok(None),
        _ => return Err("MCP_CONFIG_INVALID: 工作区服务器绑定的 engine 无效。".to_owned()),
    }
    let url = value.get("url").and_then(Value::as_str).unwrap_or("");
    let workspace_id = value
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if workspace_id.is_empty() {
        return Err("MCP_CONFIG_INVALID: 工作区服务器绑定缺少 workspaceId。".to_owned());
    }
    Ok(Some((normalize_endpoint(url)?, workspace_id.to_owned())))
}

fn normalize_endpoint(value: &str) -> Result<String, String> {
    let mut url = Url::parse(value.trim())
        .map_err(|_| "MCP_CONFIG_INVALID: MCP 服务器地址无效。".to_owned())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "MCP_CONFIG_INVALID: MCP 地址须为不含凭据、查询参数或片段的 HTTP(S) 地址。".to_owned(),
        );
    }
    let path = url.path().trim_end_matches('/');
    let path = path.strip_suffix("/mcp").unwrap_or(path).to_owned();
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

fn usable_session(
    session: Option<&BackendSession>,
    endpoint: &str,
    workspace_id: Option<&str>,
) -> bool {
    session.is_some_and(|session| {
        !session.access_token.trim().is_empty()
            && workspace_id.is_some_and(|id| !id.is_empty())
            && backend_sync::same_backend_endpoint(&session.endpoint, endpoint)
    })
}

fn read_token_file(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path)
        .map_err(|_| "MCP_AUTH_FILE: 无法读取用户提供的 MCP token 文件。".to_owned())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(
                "MCP_AUTH_FILE: MCP token 文件仅应允许当前用户读取，请将权限设为 600。".to_owned(),
            );
        }
    }
    if !metadata.is_file() {
        return Err("MCP_AUTH_FILE: MCP token 路径不是文件。".to_owned());
    }
    let token = fs::read_to_string(path)
        .map_err(|_| "MCP_AUTH_FILE: 无法读取用户提供的 MCP token 文件。".to_owned())?;
    let token = token.trim();
    if token.is_empty() {
        return Err("MCP_AUTH_FILE: 用户提供的 MCP token 文件为空。".to_owned());
    }
    Ok(token.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
        thread::{self, JoinHandle},
        time::Instant,
    };

    struct Server {
        endpoint: String,
        requests: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl Server {
        fn start(handler: impl Fn(&str, &Value) -> (u16, Value) + Send + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let received = requests.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopping = stop.clone();
            let thread = thread::spawn(move || {
                while !stopping.load(Ordering::Relaxed) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut data = Vec::new();
                    let mut chunk = [0; 4096];
                    let end = loop {
                        let n = stream.read(&mut chunk).unwrap();
                        assert!(n > 0);
                        data.extend_from_slice(&chunk[..n]);
                        if let Some(end) = data.windows(4).position(|part| part == b"\r\n\r\n") {
                            break end + 4;
                        }
                    };
                    let headers = String::from_utf8_lossy(&data[..end]).into_owned();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    while data.len() < end + length {
                        let n = stream.read(&mut chunk).unwrap();
                        assert!(n > 0);
                        data.extend_from_slice(&chunk[..n]);
                    }
                    let body = if length == 0 {
                        Value::Null
                    } else {
                        serde_json::from_slice(&data[end..end + length]).unwrap()
                    };
                    received.lock().unwrap().push(headers.clone());
                    let (status, response) = handler(&headers, &body);
                    let bytes = serde_json::to_vec(&response).unwrap();
                    write!(stream, "HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).unwrap();
                    stream.write_all(&bytes).unwrap();
                }
            });
            Self {
                endpoint,
                requests,
                stop,
                thread: Some(thread),
            }
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.thread.take().unwrap().join().unwrap();
        }
    }

    fn healthy() -> Value {
        json!({ "ok": true, "mcp": { "enabled": true, "running": true } })
    }

    fn request() -> Value {
        json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "tie_doctor", "arguments": {} } })
    }

    #[test]
    fn token_only_request_probes_health_without_credentials_then_posts() {
        let server = Server::start(|headers, body| {
            if headers.starts_with("GET /health ") {
                (200, healthy())
            } else {
                assert!(headers.starts_with("POST /mcp "));
                (
                    200,
                    json!({ "jsonrpc": "2.0", "id": body["id"], "result": { "ok": true } }),
                )
            }
        });
        let transport = HttpTransport::new(
            server.endpoint.clone(),
            None,
            Some("user-supplied-test-token".into()),
            false,
        )
        .unwrap();
        assert_eq!(transport.auth_kind(), "mcp-token");
        assert_eq!(transport.request(&request()).unwrap()["result"]["ok"], true);
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(!requests[0].to_lowercase().contains("authorization:"));
        assert!(requests[1]
            .to_lowercase()
            .contains("authorization: bearer user-supplied-test-token"));
        assert!(!requests[1].to_lowercase().contains("x-tie-workspace:"));
    }

    #[test]
    fn unhealthy_server_never_receives_a_tool_or_token() {
        let server = Server::start(|headers, _| {
            assert!(headers.starts_with("GET /health "));
            (
                200,
                json!({ "ok": true, "mcp": { "enabled": true, "running": false } }),
            )
        });
        let transport = HttpTransport::new(
            server.endpoint.clone(),
            None,
            Some("test-token".into()),
            false,
        )
        .unwrap();
        assert!(transport
            .request(&request())
            .unwrap_err()
            .starts_with("MCP_HEALTH_STOPPED"));
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn missing_authorization_requires_user_token_after_health_check() {
        let server = Server::start(|_, _| (200, healthy()));
        let transport = HttpTransport::new(server.endpoint.clone(), None, None, false).unwrap();
        assert_eq!(transport.auth_kind(), "required");
        assert!(transport
            .request(&request())
            .unwrap_err()
            .starts_with("MCP_AUTH_REQUIRED"));
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }

    #[test]
    fn valid_slow_http_result_does_not_trigger_two_second_fallback() {
        let server = Server::start(|headers, body| {
            if headers.starts_with("GET /health ") {
                return (200, healthy());
            }
            thread::sleep(Duration::from_millis(2100));
            (
                200,
                json!({ "jsonrpc": "2.0", "id": body["id"], "result": [] }),
            )
        });
        let transport = HttpTransport::new(
            server.endpoint.clone(),
            None,
            Some("test-token".into()),
            false,
        )
        .unwrap();
        let start = Instant::now();
        assert!(transport.request(&request()).unwrap()["result"].is_array());
        assert!(start.elapsed() >= Duration::from_secs(2));
    }

    #[test]
    fn mismatched_json_rpc_response_is_not_treated_as_success() {
        let server = Server::start(|headers, _| {
            if headers.starts_with("GET /health ") {
                return (200, healthy());
            }
            (200, json!({ "jsonrpc": "2.0", "id": 99, "result": {} }))
        });
        let transport = HttpTransport::new(
            server.endpoint.clone(),
            None,
            Some("test-token".into()),
            false,
        )
        .unwrap();
        assert!(transport
            .request(&request())
            .unwrap_err()
            .starts_with("MCP_HTTP_INVALID"));
    }

    #[test]
    fn http_failure_does_not_echo_the_response_or_credentials() {
        let server = Server::start(|headers, _| {
            if headers.starts_with("GET /health ") {
                return (200, healthy());
            }
            (
                502,
                json!({ "message": "test-token must not appear in errors" }),
            )
        });
        let transport = HttpTransport::new(
            server.endpoint.clone(),
            None,
            Some("test-token".into()),
            false,
        )
        .unwrap();
        let error = transport.request(&request()).unwrap_err();
        assert!(error.starts_with("MCP_HTTP_STATUS"));
        assert!(!error.contains("test-token"));
    }

    #[test]
    fn session_authorization_requires_same_backend_and_bound_workspace() {
        let session = BackendSession {
            endpoint: "https://tie.example".into(),
            access_token: "test-access".into(),
            refresh_token: String::new(),
            access_expires_at: String::new(),
            user_id: "user".into(),
            email: String::new(),
            name: String::new(),
        };
        assert!(usable_session(
            Some(&session),
            "https://tie.example/",
            Some("workspace")
        ));
        assert!(!usable_session(
            Some(&session),
            "https://other.example",
            Some("workspace")
        ));
        assert!(!usable_session(Some(&session), "https://tie.example", None));
    }

    #[test]
    fn endpoint_accepts_mcp_url_without_storing_credentials() {
        assert_eq!(
            normalize_endpoint("https://tie.example/mcp/").unwrap(),
            "https://tie.example"
        );
        assert_eq!(
            normalize_endpoint("https://tie.example/base/mcp").unwrap(),
            "https://tie.example/base"
        );
        assert!(normalize_endpoint("https://user:secret@tie.example/mcp").is_err());
        assert!(normalize_endpoint("file:///tmp/token").is_err());
        assert!(normalize_endpoint("https://tie.example/mcp?token=secret").is_err());
    }

    #[test]
    fn malformed_binding_never_becomes_an_unconfigured_local_workspace() {
        let root =
            std::env::temp_dir().join(format!("tie-mcp-binding-test-{}", std::process::id()));
        fs::create_dir_all(root.join(".tie")).unwrap();
        let path = root.join(".tie/sync.json");
        fs::write(&path, "{}").unwrap();
        assert!(read_binding(Some(&root))
            .unwrap_err()
            .starts_with("MCP_CONFIG_INVALID"));
        fs::write(&path, "{\"engine\":\"git\"}").unwrap();
        assert!(read_binding(Some(&root)).unwrap().is_none());
        fs::write(&path, "{\"engine\":\"backend\",\"url\":\"https://tie.example\",\"workspaceId\":\"workspace\"}").unwrap();
        assert_eq!(
            read_binding(Some(&root)).unwrap(),
            Some(("https://tie.example".into(), "workspace".into()))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn token_file_must_be_private() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("tie-mcp-token-test-{}", std::process::id()));
        fs::write(&path, " test-file-token\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_token_file(&path)
            .unwrap_err()
            .starts_with("MCP_AUTH_FILE"));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_token_file(&path).unwrap(), "test-file-token");
        fs::remove_file(path).unwrap();
    }
}
