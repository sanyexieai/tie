use serde_json::{json, Value};
use tie_local::{changes::ReviewFile, encryption, is_encrypted_markdown, LocalWorkspace, Page, WritePageInput};

pub(super) fn password(args: &Value) -> Result<Option<&str>, String> {
    match args.get("password") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value)),
        Some(_) => Err("password 必须是非空字符串；只用于本次调用，不会保存".into()),
    }
}

pub(super) fn require_password(args: &Value) -> Result<&str, String> {
    password(args)?.ok_or_else(|| "加密页面处于锁定状态，请提供本次操作的页面解锁密码；MCP 不会继承客户端的解锁状态".into())
}

pub(super) fn reveal(mut page: Page, args: &Value) -> Result<Value, String> {
    let encrypted = is_encrypted_markdown(&page.markdown);
    let unlocked = if encrypted {
        if let Some(password) = password(args)? {
            page.markdown = encryption::decrypt_markdown(&page.markdown, password)?;
            true
        } else { false }
    } else { true };
    let mut value = serde_json::to_value(page).map_err(|error| error.to_string())?;
    value["encrypted"] = json!(encrypted);
    value["locked"] = json!(!unlocked);
    Ok(value)
}

pub(super) fn check_page(ws: &LocalWorkspace, key: &str, args: &Value) -> Result<(), String> {
    let page = ws.resolve(key)?.ok_or_else(|| "页面不存在".to_owned())?;
    if is_encrypted_markdown(&page.markdown) {
        encryption::decrypt_markdown(&page.markdown, require_password(args)?)?;
    }
    Ok(())
}

pub(super) fn prepare_write(ws: &LocalWorkspace, args: &Value, input: &mut WritePageInput) -> Result<(), String> {
    let password = password(args)?;
    let mut encrypted = match args.get("encrypted") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(value)) => Some(*value),
        Some(_) => return Err("encrypted 必须是布尔值".into()),
    };
    let existing = if let Some(id) = &input.page_id { ws.get_by_id(id)? }
        else if input.match_title { ws.find_by_title(input.title.as_deref().unwrap_or(""))? }
        else { None };
    if existing.is_none() && encrypted.is_none() {
        if let Some(Some(parent_id)) = &input.parent_id {
            if ws.get_by_id(parent_id)?.is_some_and(|page| is_encrypted_markdown(&page.markdown)) {
                encrypted = Some(true);
            }
        }
    }
    if let Some(page) = &existing {
        let protected = is_encrypted_markdown(&page.markdown);
        if encrypted.is_some_and(|next| next != protected)
            || (!protected && input.markdown.as_ref().is_some_and(|body| is_encrypted_markdown(body))) {
            return Err("已有页面的保护模式请使用 tie_page_protection(action=convert)，以同时转换历史和讨论".into());
        }
        if protected {
            let plaintext = password.map(|password| encryption::decrypt_markdown(&page.markdown, password)).transpose()?;
            if let Some(body) = &input.markdown {
                if !is_encrypted_markdown(body) {
                    input.markdown = Some(encryption::encrypt_markdown(&tie_local::ensure_title_markdown(
                        input.title.as_deref().unwrap_or(&page.title), body), require_password(args)?)?);
                }
            } else if let (Some(title), Some(body)) = (&input.title, plaintext) {
                input.markdown = Some(encryption::encrypt_markdown(&tie_local::rename_title_markdown(title, &body), require_password(args)?)?);
            }
        }
    } else if encrypted == Some(true) {
        let password = require_password(args)?;
        let body = input.markdown.as_deref().unwrap_or("");
        input.markdown = Some(if is_encrypted_markdown(body) {
            encryption::decrypt_markdown(body, password)?;
            body.to_owned()
        } else {
            encryption::encrypt_markdown(&tie_local::ensure_title_markdown(input.title.as_deref().unwrap_or("无标题"), body), password)?
        });
    }
    Ok(())
}

pub(super) fn reveal_reviews(ws: &LocalWorkspace, page_id: &str, file: ReviewFile, args: &Value) -> Result<Value, String> {
    let encrypted = ws.get_by_id(page_id)?.is_some_and(|page| is_encrypted_markdown(&page.markdown));
    let (file, locked) = if encrypted {
        if let Some(password) = password(args)? {
            check_page(ws, page_id, args)?;
            (encryption::reveal_reviews(file, password)?, false)
        } else {
            if file.entries.iter().any(|entry| [&entry.quote, &entry.body, &entry.markdown, entry.resolution_note.as_deref().unwrap_or("")]
                .into_iter().any(|value| !value.is_empty() && !is_encrypted_markdown(value))) {
                return Err("加密页面包含旧明文讨论，请提供本次调用的解锁密码后读取".into());
            }
            (file, true)
        }
    } else { (file, false) };
    let mut value = json!(file);
    value["locked"] = json!(locked);
    value["encrypted"] = json!(encrypted);
    Ok(value)
}

pub(super) fn call(ws: &LocalWorkspace, args: &Value) -> Result<Value, String> {
    let key = super::required_str(args, "id_or_title")?;
    let page = ws.resolve(key)?.ok_or_else(|| "页面不存在".to_owned())?;
    match super::str_arg(args, "action").unwrap_or("status") {
        "status" => Ok(json!({ "pageId": page.id, "encrypted": is_encrypted_markdown(&page.markdown),
            "locked": is_encrypted_markdown(&page.markdown), "authorization": "per-call", "passwordStored": false })),
        "convert" => {
            let encrypted = args.get("encrypted").and_then(Value::as_bool).ok_or("请提供目标 encrypted 布尔值")?;
            let saved = ws.convert_page_protection(&page.id, require_password(args)?, encrypted,
                super::optional_string_arg(args, "expectedUpdatedAt")?)?;
            Ok(json!({ "page": LocalWorkspace::summarize(&saved), "encrypted": encrypted,
                "converted": true, "authorization": "per-call", "passwordStored": false }))
        }
        _ => Err("action 必须是 status 或 convert".into()),
    }
}

pub(super) fn internal(ws: &LocalWorkspace, name: &str, args: &Value) -> Result<Value, String> {
    if std::env::var("TIE_PAGE_PROTECTION_INTERNAL").ok().as_deref() != Some("1") {
        return Err("页面保护存储接口不属于公共 MCP 工具".into());
    }
    match name {
        "tie_internal_protection_read" => Ok(json!(ws.protection_bundle(super::required_str(args, "id_or_title")?)?)),
        "tie_internal_protection_replace" => {
            let bundle = serde_json::from_value(args.get("bundle").cloned().ok_or("缺少保护包")?).map_err(|_| "页面保护包无效")?;
            Ok(json!(ws.replace_page_protection(bundle, super::optional_string_arg(args, "expectedUpdatedAt")?)?))
        }
        _ => Err("未知页面保护存储接口".into()),
    }
}
