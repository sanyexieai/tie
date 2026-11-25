use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tie_local::{
    ExportOptions, ImportStrategy, LocalWorkspace, WritePageInput, DEFAULT_EXPORT_DEPTH,
};

pub fn serve(root: Option<&Path>, source_id: Option<&str>) -> Result<(), String> {
    let mut runtime = McpRuntime::new(root, source_id)?;
    let mut stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut buf = Vec::new();
    eprintln!("[tie] mcp ready");
    while let Some(message) = read_message(&mut stdin, &mut buf)? {
        if let Some(response) = runtime.handle(&message) {
            write_message(&mut stdout, &response)?;
        }
    }
    Ok(())
}

struct McpRuntime {
    root: Option<PathBuf>,
    source_id: Option<String>,
    workspace: Option<LocalWorkspace>,
    http: Result<Option<crate::mcp_http::HttpTransport>, String>,
    server: bool,
    fallback_confirmed: bool,
    pending: Option<(String, String)>,
    confirmation_number: u64,
}

impl McpRuntime {
    fn new(root: Option<&Path>, source_id: Option<&str>) -> Result<Self, String> {
        let (root, source_id) = if let Some(entry) = root {
            let (root, solution) = tie_local::resolve_workspace_entry(entry)?;
            let source_id = source_id
                .filter(|id| !id.trim().is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    solution
                        .map(|solution| solution.source_id)
                        .filter(|id| !id.trim().is_empty())
                });
            (Some(root), source_id)
        } else {
            (None, source_id.map(str::to_owned))
        };
        let server = std::env::var("TIE_MCP_VIA").ok().as_deref() == Some("http");
        let http = if server {
            Ok(None)
        } else {
            crate::mcp_http::HttpTransport::from_workspace(root.as_deref())
        };
        Ok(Self {
            root,
            source_id,
            workspace: None,
            http,
            server,
            fallback_confirmed: false,
            pending: None,
            confirmation_number: 0,
        })
    }

    fn handle(&mut self, message: &Value) -> Option<Value> {
        if message.get("id").is_none()
            || message
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("")
                .starts_with("notifications/")
        {
            return None;
        }
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(json!({}));
        let id = message["id"].clone();
        // Keep discovery available so an Agent can ask for authorization or fallback approval.
        if method == "initialize" {
            let mut response = self.remote(message).ok().flatten().unwrap_or_else(
                || json!({ "jsonrpc": "2.0", "id": id, "result": initialize(&params) }),
            );
            if let Some(result) = response.get_mut("result") {
                let connection_instructions = if self.server {
                    "当前由服务器 HTTP MCP 提供服务。请用 tie_doctor 确认 transport=http；本机文件导入与导出请由本地 CLI 执行。"
                } else {
                    "有服务器绑定时，内容请求优先使用 HTTP。HTTP 异常不会自动切换本地；调用 tie_connection 查看原因，并先向用户确认，获准后才能 confirm_local。无本地登录会话时请用户提供 MCP token。工具列表成功不代表 HTTP 已连通，请看 tie_doctor.transport。"
                };
                result["instructions"] = json!(format!("{connection_instructions} 检索知识先用 tie_tree 按层选择分类，再用 tie_search 的 root/exclude 缩小范围，必要时 tie_get 读全文。写入尽量用 parentId 归入合适的已有分类，分类非必填，不自动重排旧树。"));
            }
            return Some(response);
        }
        if method == "tools/list" {
            let mut tools = tool_defs();
            if self.server {
                tools.retain(|tool| tool["name"] != "tie_connection");
            } else if self.root.is_none() {
                tools.retain(|tool| !host_file_tool(tool["name"].as_str().unwrap_or("")));
            }
            return Some(json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools } }));
        }
        if method == "tools/call" && params["name"] == "tie_connection" && !self.server {
            let result = self.connection(&params["arguments"]);
            return Some(
                json!({ "jsonrpc": "2.0", "id": id, "result": match result { Ok(value) => tool_ok(value), Err(error) => tool_err(error) } }),
            );
        }
        let host_file = local_only_request(message);
        let probe = json!({ "jsonrpc": "2.0", "id": "tie-host-file-probe", "method": "ping" });
        match self.remote(if host_file { &probe } else { message }) {
            Ok(Some(response)) if !host_file => return Some(response),
            Ok(_) => {}
            Err(reason) if !self.fallback_confirmed => {
                let details = self.fallback_error(&reason);
                return Some(if method == "tools/call" {
                    json!({ "jsonrpc": "2.0", "id": id, "result": tool_ok_error(details) })
                } else {
                    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32001, "message": "HTTP MCP 不可用，未自动降级", "data": details } })
                });
            }
            Err(_) => {}
        }
        if self.workspace.is_none() {
            let opened = match &self.root {
                Some(root) => LocalWorkspace::open(root, self.source_id.as_deref()),
                None => Err("未配置本地工作区或 HTTP 服务器。远程接入请提供 TIE_MCP_URL 和用户签发的 MCP token。".to_owned()),
            };
            match opened {
                Ok(workspace) => self.workspace = Some(workspace),
                Err(error) => {
                    return Some(json!({ "jsonrpc": "2.0", "id": id, "result": tool_err(error) }))
                }
            }
        }
        let ws = self.workspace.as_ref().expect("local workspace opened");
        let mut response = dispatch_message(ws, message)?;
        if !self.server
            && local_write_request(message)
            && response.pointer("/result/isError").and_then(Value::as_bool) == Some(false)
        {
            attach_sync(&mut response, sync_after_write(ws));
        }
        Some(response)
    }

    fn remote(&mut self, message: &Value) -> Result<Option<Value>, String> {
        if !self.server {
            let updated = crate::mcp_http::HttpTransport::from_workspace(self.root.as_deref());
            let endpoint = |http: &Result<Option<crate::mcp_http::HttpTransport>, String>| {
                http.as_ref()
                    .ok()
                    .and_then(Option::as_ref)
                    .map(|http| http.endpoint().to_owned())
            };
            if endpoint(&updated) != endpoint(&self.http) {
                self.fallback_confirmed = false;
                self.pending = None;
            }
            self.http = updated;
        }
        let response = match &self.http {
            Ok(Some(http)) => http.request(message),
            Ok(None) => return Ok(None),
            Err(error) => Err(error.clone()),
        };
        match response {
            Ok(response) => {
                self.fallback_confirmed = false;
                self.pending = None;
                Ok(Some(response))
            }
            Err(error) => {
                if self.pending.is_none() {
                    self.confirmation_number += 1;
                    self.pending = Some((
                        format!("local-{}-{}", std::process::id(), self.confirmation_number),
                        error.clone(),
                    ));
                } else if let Some((_, reason)) = &mut self.pending {
                    *reason = error.clone();
                }
                Err(error)
            }
        }
    }

    fn fallback_error(&self, reason: &str) -> Value {
        json!({
            "code": if self.root.is_some() { "HTTP_FALLBACK_CONFIRMATION_REQUIRED" } else { "HTTP_CONNECTION_REQUIRED" },
            "reason": reason,
            "transport": "http",
            "authorizationRequired": reason.starts_with("MCP_AUTH_"),
            "localFallbackAllowed": false,
            "confirmationId": self.root.as_ref().and_then(|_| self.pending.as_ref().map(|(id, _)| id)),
            "next": if reason.starts_with("MCP_AUTH_") {
                "请由用户主动提供此服务器的 MCP token（私有 TIE_MCP_TOKEN_FILE），或重新登录。没有本地工作区时无法降级；有本地工作区且用户明确同意降级后，才可调用 tie_connection(action=confirm_local, confirmationId=本次编号, confirmed=true)。禁止 Agent 自行确认。"
            } else if self.root.is_some() {
                "尚未读写本地。请向用户说明 HTTP 失败原因与本地数据可能尚未同步，询问是否同意降级。用户明确同意后调用 tie_connection(action=confirm_local, confirmationId=本次编号, confirmed=true)，再重试原请求；禁止由 Agent 自行确认。"
            } else {
                "没有本地工作区，无法降级。请恢复服务器连接；没有可用登录会话时，由用户主动提供 MCP token。"
            }
        })
    }

    fn connection(&mut self, args: &Value) -> Result<Value, String> {
        match str_arg(args, "action").unwrap_or("status") {
            "confirm_local" => {
                let (id, _) = self
                    .pending
                    .as_ref()
                    .ok_or("没有等待用户确认的 HTTP 故障")?;
                if self.root.is_none() {
                    return Err("没有本地工作区，无法降级".into());
                }
                if args.get("confirmed").and_then(Value::as_bool) != Some(true)
                    || str_arg(args, "confirmationId") != Some(id.as_str())
                {
                    return Err("只有用户明确同意本次降级后，才能携带对应 confirmationId 和 confirmed=true 确认".into());
                }
                self.fallback_confirmed = true;
                Ok(
                    json!({ "transport": "local", "confirmed": true, "scope": "当前故障期；HTTP 恢复后自动撤销", "next": "重试原请求；仍会先尝试 HTTP，失败时才使用本地工作区" }),
                )
            }
            "status" => {
                let probe =
                    json!({ "jsonrpc": "2.0", "id": "tie-connection-probe", "method": "ping" });
                match self.remote(&probe) {
                    Ok(Some(_)) => {
                        let http = self
                            .http
                            .as_ref()
                            .ok()
                            .and_then(Option::as_ref)
                            .expect("remote");
                        Ok(
                            json!({ "ok": true, "transport": "http", "endpoint": http.endpoint(), "authorization": http.auth_kind(), "localFallbackAllowed": false }),
                        )
                    }
                    Ok(None) => Ok(
                        json!({ "ok": self.root.is_some(), "transport": "local", "mode": "local_only", "workspaceConfigured": self.root.is_some() }),
                    ),
                    Err(error) => {
                        let mut value = self.fallback_error(&error);
                        value["localFallbackAllowed"] = json!(self.fallback_confirmed);
                        Ok(value)
                    }
                }
            }
            _ => Err("action 只能是 status 或 confirm_local".into()),
        }
    }
}

fn initialize(params: &Value) -> Value {
    json!({
        "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or("2025-06-18"),
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "tie", "version": env!("CARGO_PKG_VERSION") }
    })
}

fn host_file_tool(name: &str) -> bool {
    matches!(
        name,
        "tie_file_ingest" | "tie_file_open_hint" | "tie_export" | "tie_import"
    )
}

fn local_only_request(message: &Value) -> bool {
    message.get("method").and_then(Value::as_str) == Some("tools/list")
        || (message.get("method").and_then(Value::as_str) == Some("tools/call")
            && host_file_tool(
                message
                    .pointer("/params/name")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ))
}

fn local_write_request(message: &Value) -> bool {
    message.get("method").and_then(Value::as_str) == Some("tools/call")
        && matches!(
            message.pointer("/params/name").and_then(Value::as_str),
            Some("tie_write" | "tie_import" | "tie_file_ingest")
        )
}

fn tool_ok_error(value: Value) -> Value {
    let mut result = tool_ok(value);
    result["isError"] = json!(true);
    result
}

fn sync_after_write(ws: &LocalWorkspace) -> Value {
    if tie_cli::backend_sync::mcp_http_target(ws.root()).is_none() {
        return json!({ "state": "skipped", "reason": "没有绑定服务器，已保存到本地" });
    }
    match tie_cli::backend_sync::sync_workspace(ws) {
        Ok(report) => {
            json!({ "state": if report.conflicts.is_empty() { "synced" } else { "pending" }, "report": report })
        }
        Err(_) => {
            json!({ "state": "pending", "reason": "本地写入成功，同步未完成。请检查服务器与登录状态后重试 tie sync。" })
        }
    }
}

fn attach_sync(response: &mut Value, sync: Value) {
    if let Some(content) = response
        .pointer_mut("/result/content")
        .and_then(Value::as_array_mut)
    {
        if let Some(text) = content.iter_mut().find_map(|item| item.get_mut("text")) {
            if let Some(mut value) = text
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
            {
                value["sync"] = sync;
                *text = json!(serde_json::to_string_pretty(&value).unwrap_or_default());
            }
        }
    }
}

fn dispatch_message(ws: &LocalWorkspace, message: &Value) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    if method.starts_with("notifications/") || message.get("id").is_none() {
        return None;
    }
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let params = message.get("params").cloned().unwrap_or(json!({}));
    match dispatch(ws, method, &params) {
        Ok(result) => Some(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
        Err(error) => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32603, "message": error }
        })),
    }
}

fn dispatch(ws: &LocalWorkspace, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "initialize" => Ok(initialize(params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_defs() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match call_tool(ws, name, &args) {
                Ok(value) => Ok(tool_ok(value)),
                Err(error) => Ok(tool_err(error)),
            }
        }
        _ => Err(format!("未知方法：{method}")),
    }
}

fn tool_ok(value: Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()) }],
        "isError": false
    })
}

fn tool_err(error: String) -> Value {
    json!({
        "content": [{ "type": "text", "text": error }],
        "isError": true
    })
}

fn tool_defs() -> Vec<Value> {
    vec![
        tool("tie_connection", "查看服务器连接。HTTP 异常需要先向用户询问是否降级；仅在用户明确同意后调用 confirm_local，禁止 Agent 自行确认。", obj_props(json!({
            "action": { "type": "string", "enum": ["status", "confirm_local"] },
            "confirmationId": { "type": "string" },
            "confirmed": { "type": "boolean", "description": "仅在用户明确同意当前故障期降级后设为 true" }
        }))),
        tool("tie_doctor", "诊断本机 tie MCP 与工作区。升级出问题时先调这个。", json!({ "type": "object", "properties": {} })),
        tool("tie_list_recent", "列出最近更新的页面，可限定分类子树并排除无关分支。先用 tie_tree 按层选择分类。", obj_props(json!({
            "limit": { "type": "integer", "description": "返回条数，默认 20" },
            "tag": { "type": "string", "description": "按标签精确过滤" },
            "root": { "type": "string", "description": "分类节点 ID 或唯一标题，包含该节点及全部后代；省略时不限定" },
            "exclude": { "type": "array", "items": { "type": "string" }, "description": "忽略这些节点及各自全部后代；优先使用节点 ID" }
        }))),
        tool("tie_search", "先用 tie_tree 逐级选择知识分类，再按关键词或标签搜索。root 限定相关子树，exclude 忽略无关分支；结果带分类路径。", obj_props(json!({
            "query": { "type": "string" },
            "tag": { "type": "string" },
            "limit": { "type": "integer" },
            "root": { "type": "string", "description": "分类节点 ID 或唯一标题，包含该节点及全部后代；省略时搜索全库" },
            "exclude": { "type": "array", "items": { "type": "string" }, "description": "排除节点及其全部后代；在评分及结果数量限制前裁剪" }
        }))),
        tool("tie_get", "按页面 id 或精确标题读取全文", obj_props(json!({
            "id_or_title": { "type": "string" }
        }))),
        tool("tie_related", "查看出链、入链、子页和同标签页面", obj_props(json!({
            "id_or_title": { "type": "string" }
        }))),
        tool("tie_write", "写入知识。尽量先用 tie_tree 逐级选择最合适的已有分类，通过 parentId 归类；分类非必填，没有合适分类可直接写入，不自动重排旧树。不要手写 frontmatter，不要写「我」当 actor。", obj_props(json!({
            "title": { "type": "string" },
            "markdown": { "type": "string" },
            "body": { "type": "string" },
            "pageId": { "type": "string" },
            "tags": { "type": "array", "items": { "type": "string" } },
            "parentId": { "type": ["string", "null"], "description": "建议指定最合适的分类节点 ID；省略不强制分类，更新时保留原归属；null 明确放到顶层" },
            "parentTitle": { "type": "string", "description": "父分类标题；有重名时应改用明确的 parentId" },
            "kind": { "type": "string" },
            "matchTitle": { "type": "boolean" },
            "icon": { "type": "string" },
            "actor": { "type": "string", "description": "Agent 名。不要写「我」" }
        }))),
        tool("tie_tree", "按层浏览知识分类，不返回正文。先 depth=1 看顶层，再用 root 节点 ID、depth=2 逐级展开；childCount 与 childrenTruncated 表示是否还有未展开子节点。", obj_props(json!({
            "root": { "type": "string", "description": "分类节点 ID 或唯一标题；该节点计为第一层" },
            "depth": { "type": "integer", "minimum": 1, "maximum": 8, "default": 2, "description": "返回层数，默认 2；1 只返回当前根级" }
        }))),
        tool("tie_export", "导出页面闭包到目录", obj_props(json!({
            "page": { "type": "string" },
            "depth": { "type": "integer" },
            "withChildren": { "type": "boolean" },
            "out": { "type": "string" }
        }))),
        tool("tie_import", "导入 tie_export 目录", obj_props(json!({
            "path": { "type": "string" },
            "strategy": { "type": "string", "description": "skip | overwrite | new-id" }
        }))),
        tool("tie_file_ingest", "登记外部文件或目录", obj_props(json!({
            "path": { "type": "string" },
            "mode": { "type": "string", "description": "link 或 copy" },
            "title": { "type": "string" }
        }))),
        tool("tie_file_get", "按 fileId 读文件元数据", obj_props(json!({ "fileId": { "type": "string" } }))),
        tool("tie_file_list", "列出已登记文件", obj_props(json!({
            "query": { "type": "string" },
            "ext": { "type": "string" },
            "limit": { "type": "integer" }
        }))),
        tool("tie_file_open_hint", "返回可打开路径，不替用户打开", obj_props(json!({ "fileId": { "type": "string" } }))),
        tool("tie_migration_status", "查询迁移 stamp 与需 Agent 收尾的残留", obj_props(json!({
            "migrationId": { "type": "string" },
            "limit": { "type": "integer" }
        }))),
    ]
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

fn obj_props(properties: Value) -> Value {
    json!({ "type": "object", "properties": properties })
}

fn call_tool(ws: &LocalWorkspace, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "tie_doctor" => doctor(ws),
        "tie_list_recent" => {
            let limit = int_arg(args, "limit", 20);
            let (root, exclude) = search_scope_args(args)?;
            let hits = ws.search_scoped("", str_arg(args, "tag"), limit, false, root, &exclude)?;
            Ok(json!(flatten_hits(hits)))
        }
        "tie_search" => {
            let query = str_arg(args, "query").unwrap_or("");
            let limit = int_arg(args, "limit", 12);
            let (root, exclude) = search_scope_args(args)?;
            let hits =
                ws.search_scoped(query, str_arg(args, "tag"), limit, false, root, &exclude)?;
            Ok(json!({
                "workspace": ws.root().display().to_string(),
                "backend": "tie",
                "scope": { "root": root, "exclude": exclude },
                "results": flatten_hits(hits)
            }))
        }
        "tie_get" => {
            let key = required_str(args, "id_or_title")?;
            let page = ws
                .resolve(key)?
                .ok_or_else(|| format!("页面不存在：{key}"))?;
            let mut value = serde_json::to_value(&page).map_err(|error| error.to_string())?;
            value["path"] = json!(format!("pages/{}.md", page.id));
            value["backend"] = json!("tie");
            Ok(value)
        }
        "tie_related" => {
            let key = required_str(args, "id_or_title")?;
            Ok(serde_json::to_value(ws.related(key)?).map_err(|error| error.to_string())?)
        }
        "tie_write" => write_page(ws, args),
        "tie_tree" => {
            let root = node_arg(args, "root")?;
            let depth = match args.get("depth") {
                None => 2,
                Some(value) => value
                    .as_u64()
                    .filter(|depth| (1..=8).contains(depth))
                    .ok_or("depth 必须是 1 到 8 的整数")? as usize,
            };
            Ok(serde_json::to_value(ws.tree_outline(root, depth)?).map_err(|e| e.to_string())?)
        }
        "tie_export" => {
            let page = required_str(args, "page")?;
            let depth = int_arg(args, "depth", DEFAULT_EXPORT_DEPTH);
            let with_children = args
                .get("withChildren")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let out = str_arg(args, "out")
                .map(Path::new)
                .map(|path| path.to_path_buf());
            let summary = ws.export_closure(
                page,
                &ExportOptions {
                    depth,
                    with_children,
                    out,
                },
            )?;
            Ok(serde_json::to_value(summary).map_err(|error| error.to_string())?)
        }
        "tie_import" => {
            let path = required_str(args, "path")?;
            let strategy = str_arg(args, "strategy")
                .unwrap_or("skip")
                .parse::<ImportStrategy>()?;
            Ok(
                serde_json::to_value(ws.import_closure(Path::new(path), strategy)?)
                    .map_err(|e| e.to_string())?,
            )
        }
        "tie_file_ingest" => {
            let path = required_str(args, "path")?;
            let mode = str_arg(args, "mode").unwrap_or("link");
            ws.files()
                .ingest(mode, Path::new(path), str_arg(args, "title"))
        }
        "tie_file_get" => {
            let id = required_str(args, "fileId")?;
            ws.files()
                .get(id)?
                .ok_or_else(|| format!("文件资源不存在：{id}"))
        }
        "tie_file_list" => {
            let limit = int_arg(args, "limit", 50);
            let results = ws
                .files()
                .list(str_arg(args, "query"), str_arg(args, "ext"), limit)?;
            Ok(json!({ "workspace": ws.root().display().to_string(), "results": results }))
        }
        "tie_file_open_hint" => {
            let id = required_str(args, "fileId")?;
            Ok(serde_json::to_value(ws.files().open_hint(id)?)
                .map_err(|error| error.to_string())?)
        }
        "tie_migration_status" => migration_status(ws, args),
        _ => Err(format!("未知工具：{name}")),
    }
}

fn doctor(ws: &LocalWorkspace) -> Result<Value, String> {
    let report = ws.check_format()?;
    let exe = std::env::current_exe()
        .ok()
        .map(|path| path.display().to_string());
    let ok = report.errors.is_empty();
    Ok(json!({
        "ok": ok,
        "workspace": ws.root().display().to_string(),
        "backend": "tie",
        "transport": std::env::var("TIE_MCP_VIA").unwrap_or_else(|_| "local".to_owned()),
        "tieCli": exe,
        "env": {
            "TIE_WORKSPACE": std::env::var("TIE_WORKSPACE").ok(),
            "TIE_ACTOR": std::env::var("TIE_ACTOR").ok(),
        },
        "formatCheck": report,
        "next": if !ok {
            "format check 失败：用 tie_get / tie_write 修，不要手写 frontmatter"
        } else if std::env::var("TIE_MCP_VIA").ok().as_deref() == Some("http") {
            "这次请求由后台 HTTP MCP 处理"
        } else {
            "本机 tie 在提供 MCP。绑定服务器时优先 HTTP，异常需用户明确确认后才使用本地工作区"
        }
    }))
}

fn write_page(ws: &LocalWorkspace, args: &Value) -> Result<Value, String> {
    let markdown = str_owned(args, "markdown").or_else(|| str_owned(args, "body"));
    let tags = args.get("tags").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    });
    let mut parent_id = match args.get("parentId") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) => {
            Some(Some(value.trim().to_owned()).filter(|id| !id.is_empty()))
        }
        Some(_) => return Err("parentId 必须是分类节点 ID 或 null".into()),
    };
    if let Some(title) = node_arg(args, "parentTitle")? {
        let parent = ws
            .tree_outline(Some(title), 1)?
            .into_iter()
            .next()
            .ok_or("父分类不存在")?;
        if parent_id
            .as_ref()
            .is_some_and(|id| id.as_deref() != Some(parent.page.id.as_str()))
        {
            return Err("parentId 与 parentTitle 指向不同分类，请用明确的 parentId".into());
        }
        parent_id = Some(Some(parent.page.id));
    }
    let saved = ws.write_page(WritePageInput {
        title: str_owned(args, "title"),
        markdown,
        page_id: str_owned(args, "pageId"),
        tags,
        parent_id,
        parent_title: None,
        kind: str_owned(args, "kind"),
        match_title: args
            .get("matchTitle")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        icon: str_owned(args, "icon"),
    })?;
    append_audit(
        ws.root(),
        &json!({
            "type": "write",
            "actor": resolve_actor(str_arg(args, "actor")),
            "pageId": saved.page.id,
            "title": saved.page.title,
            "status": "applied"
        }),
    );
    Ok(serde_json::to_value(saved).map_err(|error| error.to_string())?)
}

fn flatten_hits(hits: Vec<tie_local::SearchHit>) -> Vec<Value> {
    hits.into_iter()
        .filter_map(|hit| {
            let mut page = serde_json::to_value(hit.page).ok()?;
            page["snippet"] = json!(hit.snippet);
            page["score"] = json!(hit.score);
            page["breadcrumb"] = json!(hit
                .breadcrumb
                .into_iter()
                .map(|ancestor| json!({ "id": ancestor.id, "title": ancestor.title }))
                .collect::<Vec<_>>());
            Some(page)
        })
        .collect()
}

fn node_arg<'a>(args: &'a Value, name: &str) -> Result<Option<&'a str>, String> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.trim())),
        Some(Value::String(_)) => Err(format!("{name} 不能为空，请提供节点 ID 或唯一标题")),
        Some(_) => Err(format!("{name} 必须是节点 ID 或标题字符串")),
    }
}

fn search_scope_args(args: &Value) -> Result<(Option<&str>, Vec<String>), String> {
    let root = node_arg(args, "root")?;
    let exclude = match args.get("exclude") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| "exclude 的每一项必须是非空节点 ID 或标题".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("exclude 必须是节点 ID 或标题的数组".into()),
    };
    Ok((root, exclude))
}

fn migration_status(ws: &LocalWorkspace, args: &Value) -> Result<Value, String> {
    let catalog = json!([{
        "id": "href-file-protocol-v1",
        "title": "file:/// → tie://path|file",
        "agentFollowUp": true,
        "skill": "tie-update",
        "residual": "file:///"
    }]);
    let stamp_path = ws.root().join(".tie").join("migrations.json");
    let applied = std::fs::read_to_string(&stamp_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("applied").cloned())
        .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
        .unwrap_or_default();
    let wanted = str_arg(args, "migrationId");
    if let Some(id) = wanted {
        if id != "href-file-protocol-v1" {
            return Ok(json!({
                "workspace": ws.root().display().to_string(),
                "error": format!("未知 migrationId：{id}"),
                "knownIds": ["href-file-protocol-v1"],
                "applied": applied
            }));
        }
    }
    let applied_flag = applied.iter().any(|id| id == "href-file-protocol-v1");
    let limit = int_arg(args, "limit", 50);
    let mut remaining_pages = Vec::new();
    let mut remaining_hrefs = 0usize;
    if applied_flag {
        for summary in ws.list_pages(false)? {
            if remaining_pages.len() >= limit {
                break;
            }
            let Some(page) = ws.resolve(&summary.id)? else {
                continue;
            };
            let hrefs = file_hrefs(&page.markdown);
            if hrefs.is_empty() {
                continue;
            }
            remaining_hrefs += hrefs.len();
            remaining_pages.push(json!({
                "id": page.id,
                "title": page.title,
                "count": hrefs.len(),
                "hrefs": hrefs.into_iter().take(20).collect::<Vec<_>>(),
                "updatedAt": page.updated_at
            }));
        }
    }
    let remaining = remaining_pages.len();
    let entry = json!({
        "id": "href-file-protocol-v1",
        "title": "file:/// → tie://path|file",
        "agentFollowUp": true,
        "skill": "tie-update",
        "applied": applied_flag,
        "remaining": remaining,
        "remainingPages": remaining_pages,
        "remainingHrefs": remaining_hrefs
    });
    let needs = applied_flag && remaining > 0;
    Ok(json!({
        "workspace": ws.root().display().to_string(),
        "stampPath": stamp_path.display().to_string(),
        "stampExists": stamp_path.is_file(),
        "applied": applied,
        "needsAgentFollowUp": needs,
        "migrations": [entry],
        "catalog": catalog,
        "guidance": if needs { "按 Skill tie-update 处理残留" } else { "当前无需要 Agent 收尾的残留" }
    }))
}

fn file_hrefs(markdown: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = markdown;
    let mut rest = lower;
    while let Some(index) = rest.find("file://") {
        let start = index;
        let tail = &rest[start..];
        let end = tail
            .find(|ch: char| ch.is_whitespace() || matches!(ch, ')' | ']' | '>' | '\'' | '"'))
            .unwrap_or(tail.len());
        let href = tail[..end].to_owned();
        if !out.contains(&href) {
            out.push(href);
        }
        rest = &tail[end..];
    }
    out
}

fn append_audit(root: &Path, event: &Value) {
    let dir = root.join(".tie").join("audit");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut line = json!({ "at": chrono_stamp() });
    if let (Some(obj), Some(extra)) = (line.as_object_mut(), event.as_object()) {
        for (key, value) in extra {
            obj.insert(key.clone(), value.clone());
        }
    }
    let path = dir.join("events.jsonl");
    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        Ok(file) => file,
        Err(_) => return,
    };
    let _ = writeln!(file, "{line}");
}

fn chrono_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
}

fn resolve_actor(explicit: Option<&str>) -> String {
    let raw = explicit.unwrap_or("").trim();
    let generic = raw.is_empty()
        || raw == "我"
        || matches!(
            raw.to_ascii_lowercase().as_str(),
            "me" | "i" | "user" | "myself" | "mcp" | "mcp-http"
        );
    if !generic {
        return raw.to_owned();
    }
    std::env::var("TIE_ACTOR")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "mcp".into())
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn str_owned(args: &Value, key: &str) -> Option<String> {
    str_arg(args, key).map(str::to_owned)
}

fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    str_arg(args, key).ok_or_else(|| format!("缺少 {key}"))
}

fn int_arg(args: &Value, key: &str, default: usize) -> usize {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(default)
        .max(1)
}

fn write_message(stdout: &mut impl Write, value: &Value) -> Result<(), String> {
    // Cursor 的 stdio 客户端只按换行切分 JSON，不认 Content-Length。
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if body.contains(&b'\n') || body.contains(&b'\r') {
        return Err("MCP 消息不能包含换行".into());
    }
    stdout.write_all(&body).map_err(|error| error.to_string())?;
    stdout.write_all(b"\n").map_err(|error| error.to_string())?;
    stdout.flush().map_err(|error| error.to_string())
}

fn read_message(stdin: &mut impl Read, buf: &mut Vec<u8>) -> Result<Option<Value>, String> {
    loop {
        if let Some(message) = take_message(buf)? {
            return Ok(Some(message));
        }
        let mut chunk = [0u8; 4096];
        let read = stdin.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            return if buf.iter().all(u8::is_ascii_whitespace) {
                Ok(None)
            } else {
                Err("MCP 消息不完整".into())
            };
        }
        buf.extend_from_slice(&chunk[..read]);
    }
}

fn take_message(buf: &mut Vec<u8>) -> Result<Option<Value>, String> {
    let start = buf
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(buf.len());
    if start > 0 {
        buf.drain(..start);
    }
    if buf.is_empty() {
        return Ok(None);
    }
    if buf[0] == b'{' {
        let Some(end) = buf.iter().position(|byte| *byte == b'\n') else {
            return Ok(None);
        };
        let line: Vec<u8> = buf.drain(..=end).collect();
        let text = String::from_utf8_lossy(&line);
        return serde_json::from_str(text.trim())
            .map(Some)
            .map_err(|error| error.to_string());
    }
    let header_end = header_end(buf);
    let Some(header_end) = header_end else {
        return Ok(None);
    };
    let header = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let length = header
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .ok_or_else(|| "MCP 消息缺少 Content-Length".to_owned())?;
    if buf.len() < header_end + length {
        return Ok(None);
    }
    let body: Vec<u8> = buf.drain(..header_end + length).skip(header_end).collect();
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
        .or_else(|| {
            buf.windows(2)
                .position(|window| window == b"\n\n")
                .map(|index| index + 2)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_tie_tools() {
        let dir = std::env::temp_dir().join(format!("tie-mcp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ws = LocalWorkspace::init(&dir, "").expect("init");
        let listed = dispatch(&ws, "tools/list", &json!({})).expect("list");
        let names = listed["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .filter_map(|item| item["name"].as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"tie_doctor"));
        assert!(names.contains(&"tie_search"));
        assert!(names.contains(&"tie_write"));
        for name in [
            "tie_file_ingest",
            "tie_file_open_hint",
            "tie_export",
            "tie_import",
        ] {
            assert!(names.contains(&name));
        }
        let doctor = dispatch(
            &ws,
            "tools/call",
            &json!({"name": "tie_doctor", "arguments": {}}),
        )
        .expect("doctor");
        assert_eq!(doctor["isError"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn host_file_tools_and_tool_list_stay_local() {
        assert!(local_only_request(&json!({"method": "tools/list"})));
        for name in [
            "tie_file_ingest",
            "tie_file_open_hint",
            "tie_export",
            "tie_import",
        ] {
            let message = json!({"method": "tools/call", "params": {"name": name}});
            assert!(local_only_request(&message), "{name}");
        }
        for name in [
            "tie_search",
            "tie_get",
            "tie_write",
            "tie_file_list",
            "tie_file_get",
        ] {
            let message = json!({"method": "tools/call", "params": {"name": name}});
            assert!(!local_only_request(&message), "{name}");
        }
        assert!(!local_only_request(&json!({"method": "initialize"})));
    }

    #[test]
    fn scoped_search_and_tree_keep_only_relevant_knowledge() {
        let dir =
            std::env::temp_dir().join(format!("tie-mcp-categories-{}", tie_local::new_page_id()));
        let ws = LocalWorkspace::init(&dir, "src_test").unwrap();
        let save = |title: &str, body: &str, parent: Option<&str>| {
            ws.write_page(WritePageInput {
                title: Some(title.into()),
                markdown: Some(body.into()),
                parent_id: parent.map(|id| Some(id.to_owned())),
                ..Default::default()
            })
            .unwrap()
            .page
        };
        let project = save("项目", "# 项目", None);
        let operations = save("运维", "# 运维", Some(&project.id));
        let archive = save("旧方案", "# 旧方案", Some(&operations.id));
        let current = save("Nginx 排障", "nginx current fix", Some(&operations.id));
        save(
            "已废弃的 Nginx 方案",
            "nginx nginx nginx",
            Some(&archive.id),
        );
        save("其它项目资料", "nginx nginx nginx", None);

        let response = dispatch(
            &ws,
            "tools/call",
            &json!({"name":"tie_tree", "arguments":{"root":project.id,"depth":1}}),
        )
        .unwrap();
        let tree: Value =
            serde_json::from_str(response["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(tree[0]["childCount"], 1);
        assert_eq!(tree[0]["childrenTruncated"], true);
        assert_eq!(tree[0]["children"], json!([]));

        let response = dispatch(&ws, "tools/call", &json!({"name":"tie_search", "arguments":{"query":"nginx","root":operations.id,"exclude":[archive.id],"limit":1}})).unwrap();
        assert_eq!(response["isError"], false);
        let result: Value =
            serde_json::from_str(response["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(result["results"].as_array().unwrap().len(), 1);
        assert_eq!(result["results"][0]["id"], current.id);
        assert_eq!(
            result["results"][0]["breadcrumb"],
            json!([
                {"id":project.id,"title":"项目"}, {"id":operations.id,"title":"运维"}
            ])
        );
        assert!(result["results"][0]["breadcrumb"][0]
            .get("markdown")
            .is_none());

        let recent = call_tool(
            &ws,
            "tie_list_recent",
            &json!({"root":operations.id,"exclude":[archive.id],"limit":50}),
        )
        .unwrap();
        assert_eq!(recent.as_array().unwrap().len(), 2);
        assert!(recent
            .as_array()
            .unwrap()
            .iter()
            .all(|page| page["id"] == operations.id || page["id"] == current.id));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_scopes_do_not_turn_into_global_queries() {
        let dir = std::env::temp_dir().join(format!(
            "tie-mcp-invalid-scope-{}",
            tie_local::new_page_id()
        ));
        let ws = LocalWorkspace::init(&dir, "src_test").unwrap();
        for args in [
            json!({"root":42}),
            json!({"root":""}),
            json!({"root":"   "}),
            json!({"exclude":"wrong"}),
            json!({"exclude":[true]}),
            json!({"exclude":[""]}),
        ] {
            assert!(call_tool(&ws, "tie_search", &args).is_err());
        }
        for depth in [json!(0), json!(9), json!("2"), json!(1.5)] {
            assert!(call_tool(&ws, "tie_tree", &json!({"depth":depth})).is_err());
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn classification_is_optional_but_titles_must_be_unambiguous() {
        let dir = std::env::temp_dir().join(format!(
            "tie-mcp-write-category-{}",
            tie_local::new_page_id()
        ));
        let ws = LocalWorkspace::init(&dir, "src_test").unwrap();
        let first = write_page(&ws, &json!({"title":"运维","markdown":"# 运维"})).unwrap();
        let classified = write_page(
            &ws,
            &json!({"title":"配置","markdown":"# 配置", "parentTitle":"运维"}),
        )
        .unwrap();
        assert_eq!(classified["page"]["parentId"], first["page"]["id"]);
        write_page(&ws, &json!({"title":"运维","markdown":"# 运维"})).unwrap();
        assert!(
            write_page(&ws, &json!({"title":"不能错放","parentTitle":"运维"}))
                .unwrap_err()
                .contains("不唯一")
        );
        assert!(write_page(&ws, &json!({"title":"错误分类","parentId":true})).is_err());
        let explicit = write_page(
            &ws,
            &json!({"title":"正确分类","parentId":format!(" {} ", first["page"]["id"].as_str().unwrap())}),
        )
        .unwrap();
        assert_eq!(explicit["page"]["parentId"], first["page"]["id"]);
        let unclassified =
            write_page(&ws, &json!({"title":"暂未分类","markdown":"# 暂未分类"})).unwrap();
        assert!(unclassified["page"]["parentId"].is_null());
        let updated = write_page(
            &ws,
            &json!({"pageId":classified["page"]["id"],"markdown":"# 更新内容"}),
        )
        .unwrap();
        assert_eq!(updated["page"]["parentId"], first["page"]["id"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn writes_newline_delimited_json() {
        let message = json!({"jsonrpc":"2.0","id":1,"result":{"ok":true}});
        let mut buf = Vec::new();
        write_message(&mut buf, &message).expect("write");
        let text = String::from_utf8(buf.clone()).expect("utf8");
        assert!(text.ends_with('\n'));
        assert_eq!(text.matches('\n').count(), 1);
        assert!(!text.contains("Content-Length"));
        let parsed = take_message(&mut buf).expect("read").expect("message");
        assert_eq!(parsed, message);
        assert!(buf.is_empty());
    }

    #[test]
    fn reads_backend_target_from_sync_file() {
        let dir = std::env::temp_dir().join(format!("tie-mcp-target-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ws = LocalWorkspace::init(&dir, "").expect("init");
        assert!(tie_cli::backend_sync::mcp_http_target(ws.root()).is_none());
        let tie = dir.join(".tie");
        std::fs::create_dir_all(&tie).expect("tie");
        std::fs::write(
            tie.join("sync.json"),
            "{\n  \"engine\": \"backend\",\n  \"url\": \"http://127.0.0.1:8787\",\n  \"workspaceId\": \"ws_demo\"\n}\n",
        )
        .expect("sync");
        let target = tie_cli::backend_sync::mcp_http_target(ws.root()).expect("target");
        assert_eq!(target.url, "http://127.0.0.1:8787");
        assert_eq!(target.workspace_id, "ws_demo");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
