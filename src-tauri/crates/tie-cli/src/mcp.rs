use std::io::{Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tie_local::{ExportOptions, ImportStrategy, LocalWorkspace, WritePageInput, DEFAULT_EXPORT_DEPTH};

pub fn serve(ws: &LocalWorkspace) -> Result<(), String> {
    let mut stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut buf = Vec::new();
    let mut http_down_until: Option<Instant> = None;
    eprintln!(
        "[tie] mcp ready · workspace={}",
        ws.root().display()
    );
    loop {
        let Some(message) = read_message(&mut stdin, &mut buf)? else {
            return Ok(());
        };
        if message.get("id").is_some() {
            let cooled = http_down_until.is_some_and(|until| Instant::now() < until);
            if !cooled {
                match try_http(ws, &message) {
                    HttpAttempt::Hit(response) => {
                        if http_down_until.take().is_some() {
                            eprintln!("[tie] mcp 后台 HTTP 已恢复");
                        }
                        write_message(&mut stdout, &response)?;
                        continue;
                    }
                    HttpAttempt::Miss => {
                        if http_down_until.is_none() {
                            eprintln!("[tie] mcp 后台 HTTP 不通，改用本地工作区");
                        }
                        http_down_until = Some(Instant::now() + Duration::from_secs(15));
                    }
                    HttpAttempt::Skip => {}
                }
            }
        }
        if let Some(response) = dispatch_message(ws, &message) {
            write_message(&mut stdout, &response)?;
        }
    }
}

enum ForwardFail {
    Down,
    Auth,
    Target,
}

enum HttpAttempt {
    Hit(Value),
    Miss,
    Skip,
}

fn try_http(ws: &LocalWorkspace, message: &Value) -> HttpAttempt {
    if local_only_request(message) {
        return HttpAttempt::Skip;
    }
    let Some(target) = tie_cli::backend_sync::mcp_http_target(ws.root()) else {
        return HttpAttempt::Skip;
    };
    let Ok(session) = tie_cli::backend_sync::ensure_session(false) else {
        return HttpAttempt::Skip;
    };
    match post_mcp(&target.url, &session.endpoint, &session.access_token, &target.workspace_id, message) {
        Ok(value) => HttpAttempt::Hit(value),
        Err(ForwardFail::Auth) => {
            let Ok(session) = tie_cli::backend_sync::ensure_session(true) else {
                return HttpAttempt::Miss;
            };
            match post_mcp(&target.url, &session.endpoint, &session.access_token, &target.workspace_id, message) {
                Ok(value) => HttpAttempt::Hit(value),
                Err(ForwardFail::Target) => HttpAttempt::Skip,
                Err(_) => HttpAttempt::Miss,
            }
        }
        Err(ForwardFail::Down) => HttpAttempt::Miss,
        Err(ForwardFail::Target) => HttpAttempt::Skip,
    }
}

fn local_only_request(message: &Value) -> bool {
    match message.get("method").and_then(Value::as_str) {
        Some("tools/list") => true,
        Some("tools/call") => matches!(
            message.pointer("/params/name").and_then(Value::as_str),
            Some("tie_file_ingest" | "tie_file_open_hint" | "tie_export" | "tie_import")
        ),
        _ => false,
    }
}

fn post_mcp(url: &str, session_endpoint: &str, token: &str, workspace_id: &str, message: &Value) -> Result<Value, ForwardFail> {
    if !tie_cli::backend_sync::same_backend_endpoint(url, session_endpoint) {
        return Err(ForwardFail::Target);
    }
    let endpoint = format!("{}/mcp", url.trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| ForwardFail::Down)?;
    let response = client
        .post(endpoint)
        .bearer_auth(token)
        .header("x-tie-workspace", workspace_id)
        .json(message)
        .send();
    let response = match response {
        Ok(response) => response,
        Err(_) => return Err(ForwardFail::Down),
    };
    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return Err(ForwardFail::Auth);
    }
    if !(200..300).contains(&status) {
        return Err(ForwardFail::Down);
    }
    response.json().map_err(|_| ForwardFail::Down)
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
        "initialize" => Ok(json!({
            "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or("2024-11-05"),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "tie", "version": env!("CARGO_PKG_VERSION") }
        })),
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
        tool("tie_doctor", "诊断本机 tie MCP 与工作区。升级出问题时先调这个。", json!({ "type": "object", "properties": {} })),
        tool("tie_list_recent", "列出最近更新的页面", obj_props(json!({
            "limit": { "type": "integer", "description": "返回条数，默认 20" },
            "tag": { "type": "string", "description": "按标签精确过滤" }
        }))),
        tool("tie_search", "按关键词或标签搜索页面", obj_props(json!({
            "query": { "type": "string" },
            "tag": { "type": "string" },
            "limit": { "type": "integer" }
        }))),
        tool("tie_get", "按页面 id 或精确标题读取全文", obj_props(json!({
            "id_or_title": { "type": "string" }
        }))),
        tool("tie_related", "查看出链、入链、子页和同标签页面", obj_props(json!({
            "id_or_title": { "type": "string" }
        }))),
        tool("tie_write", "写入页面。不要手写 frontmatter，不要写「我」当 actor。", obj_props(json!({
            "title": { "type": "string" },
            "markdown": { "type": "string" },
            "body": { "type": "string" },
            "pageId": { "type": "string" },
            "tags": { "type": "array", "items": { "type": "string" } },
            "parentId": {},
            "parentTitle": { "type": "string" },
            "kind": { "type": "string" },
            "matchTitle": { "type": "boolean" },
            "icon": { "type": "string" },
            "actor": { "type": "string", "description": "Agent 名。不要写「我」" }
        }))),
        tool("tie_tree", "页面树", obj_props(json!({ "root": { "type": "string" } }))),
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
            let hits = ws.list_recent(limit, str_arg(args, "tag"))?;
            Ok(json!(flatten_hits(hits)))
        }
        "tie_search" => {
            let query = str_arg(args, "query").unwrap_or("");
            let limit = int_arg(args, "limit", 12);
            let hits = ws.search(query, str_arg(args, "tag"), limit, false)?;
            Ok(json!({
                "workspace": ws.root().display().to_string(),
                "backend": "tie",
                "results": flatten_hits(hits)
            }))
        }
        "tie_get" => {
            let key = required_str(args, "id_or_title")?;
            let page = ws.resolve(key)?.ok_or_else(|| format!("页面不存在：{key}"))?;
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
        "tie_tree" => Ok(serde_json::to_value(ws.tree(str_arg(args, "root"))?).map_err(|e| e.to_string())?),
        "tie_export" => {
            let page = required_str(args, "page")?;
            let depth = int_arg(args, "depth", DEFAULT_EXPORT_DEPTH);
            let with_children = args.get("withChildren").and_then(Value::as_bool).unwrap_or(true);
            let out = str_arg(args, "out").map(Path::new).map(|path| path.to_path_buf());
            let summary = ws.export_closure(page, &ExportOptions { depth, with_children, out })?;
            Ok(serde_json::to_value(summary).map_err(|error| error.to_string())?)
        }
        "tie_import" => {
            let path = required_str(args, "path")?;
            let strategy = str_arg(args, "strategy").unwrap_or("skip").parse::<ImportStrategy>()?;
            Ok(serde_json::to_value(ws.import_closure(Path::new(path), strategy)?).map_err(|e| e.to_string())?)
        }
        "tie_file_ingest" => {
            let path = required_str(args, "path")?;
            let mode = str_arg(args, "mode").unwrap_or("link");
            ws.files().ingest(mode, Path::new(path), str_arg(args, "title"))
        }
        "tie_file_get" => {
            let id = required_str(args, "fileId")?;
            ws.files().get(id)?.ok_or_else(|| format!("文件资源不存在：{id}"))
        }
        "tie_file_list" => {
            let limit = int_arg(args, "limit", 50);
            let results = ws.files().list(str_arg(args, "query"), str_arg(args, "ext"), limit)?;
            Ok(json!({ "workspace": ws.root().display().to_string(), "results": results }))
        }
        "tie_file_open_hint" => {
            let id = required_str(args, "fileId")?;
            Ok(serde_json::to_value(ws.files().open_hint(id)?).map_err(|error| error.to_string())?)
        }
        "tie_migration_status" => migration_status(ws, args),
        _ => Err(format!("未知工具：{name}")),
    }
}

fn doctor(ws: &LocalWorkspace) -> Result<Value, String> {
    let report = ws.check_format()?;
    let exe = std::env::current_exe().ok().map(|path| path.display().to_string());
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
            "本机 tie 在提供 MCP。后台 HTTP 可用时会先走后台，不通再用这个工作区"
        }
    }))
}

fn write_page(ws: &LocalWorkspace, args: &Value) -> Result<Value, String> {
    let markdown = str_owned(args, "markdown").or_else(|| str_owned(args, "body"));
    let tags = args.get("tags").and_then(Value::as_array).map(|items| {
        items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect::<Vec<_>>()
    });
    let parent_id = match args.get("parentId") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(value) => Some(Some(value.as_str().unwrap_or("").to_owned())),
    };
    let saved = ws.write_page(WritePageInput {
        title: str_owned(args, "title"),
        markdown,
        page_id: str_owned(args, "pageId"),
        tags,
        parent_id,
        parent_title: str_owned(args, "parentTitle"),
        kind: str_owned(args, "kind"),
        match_title: args.get("matchTitle").and_then(Value::as_bool).unwrap_or(false),
        icon: str_owned(args, "icon"),
    })?;
    append_audit(ws.root(), &json!({
        "type": "write",
        "actor": resolve_actor(str_arg(args, "actor")),
        "pageId": saved.page.id,
        "title": saved.page.title,
        "status": "applied"
    }));
    Ok(serde_json::to_value(saved).map_err(|error| error.to_string())?)
}

fn flatten_hits(hits: Vec<tie_local::SearchHit>) -> Vec<Value> {
    hits.into_iter().filter_map(|hit| {
        let mut page = serde_json::to_value(hit.page).ok()?;
        page["snippet"] = json!(hit.snippet);
        page["score"] = json!(hit.score);
        Some(page)
    }).collect()
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
            let Some(page) = ws.resolve(&summary.id)? else { continue };
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
        let end = tail.find(|ch: char| ch.is_whitespace() || matches!(ch, ')' | ']' | '>' | '\'' | '"')).unwrap_or(tail.len());
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
    let mut file = match std::fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(file) => file,
        Err(_) => return,
    };
    let _ = writeln!(file, "{line}");
}

fn chrono_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    secs.to_string()
}

fn resolve_actor(explicit: Option<&str>) -> String {
    let raw = explicit.unwrap_or("").trim();
    let generic = raw.is_empty()
        || raw == "我"
        || matches!(raw.to_ascii_lowercase().as_str(), "me" | "i" | "user" | "myself" | "mcp" | "mcp-http");
    if !generic {
        return raw.to_owned();
    }
    std::env::var("TIE_ACTOR").ok().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty()).unwrap_or_else(|| "mcp".into())
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty())
}

fn str_owned(args: &Value, key: &str) -> Option<String> {
    str_arg(args, key).map(str::to_owned)
}

fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    str_arg(args, key).ok_or_else(|| format!("缺少 {key}"))
}

fn int_arg(args: &Value, key: &str, default: usize) -> usize {
    args.get(key).and_then(Value::as_u64).map(|value| value as usize).unwrap_or(default).max(1)
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
    let start = buf.iter().position(|byte| !byte.is_ascii_whitespace()).unwrap_or(buf.len());
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
        return serde_json::from_str(text.trim()).map(Some).map_err(|error| error.to_string());
    }
    let header_end = header_end(buf);
    let Some(header_end) = header_end else {
        return Ok(None);
    };
    let header = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let length = header.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("content-length") {
            value.trim().parse::<usize>().ok()
        } else {
            None
        }
    }).ok_or_else(|| "MCP 消息缺少 Content-Length".to_owned())?;
    if buf.len() < header_end + length {
        return Ok(None);
    }
    let body: Vec<u8> = buf.drain(..header_end + length).skip(header_end).collect();
    serde_json::from_slice(&body).map(Some).map_err(|error| error.to_string())
}

fn header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n").map(|index| index + 4)
        .or_else(|| buf.windows(2).position(|window| window == b"\n\n").map(|index| index + 2))
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
        let names = listed["tools"].as_array().expect("tools").iter().filter_map(|item| item["name"].as_str()).collect::<Vec<_>>();
        assert!(names.contains(&"tie_doctor"));
        assert!(names.contains(&"tie_search"));
        assert!(names.contains(&"tie_write"));
        for name in ["tie_file_ingest", "tie_file_open_hint", "tie_export", "tie_import"] {
            assert!(names.contains(&name));
        }
        let doctor = dispatch(&ws, "tools/call", &json!({"name": "tie_doctor", "arguments": {}})).expect("doctor");
        assert_eq!(doctor["isError"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn host_file_tools_and_tool_list_stay_local() {
        assert!(local_only_request(&json!({"method": "tools/list"})));
        for name in ["tie_file_ingest", "tie_file_open_hint", "tie_export", "tie_import"] {
            let message = json!({"method": "tools/call", "params": {"name": name}});
            assert!(local_only_request(&message), "{name}");
        }
        for name in ["tie_search", "tie_get", "tie_write", "tie_file_list", "tie_file_get"] {
            let message = json!({"method": "tools/call", "params": {"name": name}});
            assert!(!local_only_request(&message), "{name}");
        }
        assert!(!local_only_request(&json!({"method": "initialize"})));
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
    fn closed_http_port_is_unavailable() {
        let error = post_mcp(
            "http://127.0.0.1:1",
            "http://127.0.0.1:1",
            "token",
            "ws_test",
            &json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
        )
        .expect_err("closed");
        assert!(matches!(error, ForwardFail::Down));
    }

    #[test]
    fn different_backend_is_rejected_before_http() {
        let error = post_mcp(
            "http://127.0.0.1:1",
            "https://backend.example",
            "unused",
            "ws_test",
            &json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
        )
        .expect_err("different server");
        assert!(matches!(error, ForwardFail::Target));
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
