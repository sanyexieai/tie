//! Shared per-page changes and discussion records. Replication carries original event IDs.
use crate::{
    api::format_utc_millis_pub,
    page::{is_encrypted_markdown, page_has_changed, read_stored_page, revision_id},
    paths::find_page_file,
};
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, fs, path::Path};
use tie_common::{identity::ChangeOrigin, Page};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewEntry {
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
    pub id: String,
    pub at: String,
    pub actor: String,
    pub kind: String,
    pub side: String,
    pub status: String,
    pub title: String,
    pub markdown: String,
    pub quote: String,
    pub body: String,
    pub opinion_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<ChangeOrigin>,
    #[serde(rename = "type")]
    pub event_type: String,
    pub page_id: String,
    pub changed_fields: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_id: Option<String>,
    pub base_updated_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution_origin: Option<ChangeOrigin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution_note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_updated_at: Option<String>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct ReviewFile {
    pub entries: Vec<ReviewEntry>,
}
#[derive(Clone, Default)]
struct Context {
    origin: Option<ChangeOrigin>,
    event_type: Option<String>,
    replication: bool,
    revision_id: Option<String>,
}
thread_local! { static CONTEXT: RefCell<Context> = RefCell::new(Context::default()); }
struct Restore(Context);
impl Drop for Restore {
    fn drop(&mut self) {
        CONTEXT.with(|slot| *slot.borrow_mut() = self.0.clone());
    }
}

pub fn with_change_context<T>(
    origin: ChangeOrigin,
    event_type: Option<&str>,
    replication: bool,
    run: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let previous = CONTEXT.with(|slot| {
        slot.replace(Context {
            origin: Some(origin),
            event_type: event_type.map(str::to_owned),
            replication,
            revision_id: None,
        })
    });
    let _restore = Restore(previous);
    run()
}
pub fn with_revision_context<T>(
    revision_id: &str,
    run: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let mut context = CONTEXT.with(|slot| slot.borrow().clone());
    context.revision_id = Some(revision_id.into());
    context.event_type = Some("restore".into());
    let previous = CONTEXT.with(|slot| slot.replace(context));
    let _restore = Restore(previous);
    run()
}
pub fn current_origin() -> ChangeOrigin {
    CONTEXT
        .with(|slot| slot.borrow().origin.clone())
        .unwrap_or_else(|| {
            if let Ok(raw) = std::env::var("TIE_CHANGE_ORIGIN") {
                return serde_json::from_str(&raw).unwrap_or_default();
            }
            if std::env::var("TIE_MCP_VIA").ok().as_deref() == Some("http") {
                return ChangeOrigin::default();
            }
            tie_common::identity::local_change_origin(
                "tie-cli",
                "Tie CLI",
                env!("CARGO_PKG_VERSION"),
            )
            .unwrap_or_default()
        })
}
pub fn origin_header(origin: &ChangeOrigin) -> Result<String, String> {
    let bytes = serde_json::to_vec(origin).map_err(|error| error.to_string())?;
    Ok(bytes
        .iter()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(byte) {
                (*byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect())
}
pub fn now() -> String {
    format_utc_millis_pub(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    )
}
fn review_path(root: &Path, id: &str) -> Result<std::path::PathBuf, String> {
    if id.is_empty() || id.contains(['/', '\\']) || id.contains("..") {
        return Err("页面 id 无效".into());
    }
    Ok(root.join(".tie/reviews").join(format!("{id}.json")))
}
pub fn list_reviews(root: &Path, id: &str) -> Result<ReviewFile, String> {
    match fs::read(review_path(root, id)?) {
        Ok(raw) => serde_json::from_slice(&raw).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ReviewFile::default()),
        Err(error) => Err(error.to_string()),
    }
}
pub fn write_reviews(root: &Path, id: &str, file: &ReviewFile) -> Result<(), String> {
    validate_protected_reviews(root, id, &file.entries)?;
    let path = review_path(root, id)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", revision_id()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(file).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}
struct ReviewLock(std::path::PathBuf);
impl Drop for ReviewLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
pub(crate) fn with_review_lock<T>(
    root: &Path,
    id: &str,
    run: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let path = review_path(root, id)?.with_extension("lock");
    fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
    let started = std::time::Instant::now();
    let _lock = loop {
        match fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
        {
            Ok(_) => break ReviewLock(path),
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    && started.elapsed() < std::time::Duration::from_secs(5) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            Err(error) => return Err(format!("变更记录正忙或无法写入：{error}")),
        }
    };
    run()
}
pub fn merge_review_file(
    root: &Path,
    id: &str,
    incoming: ReviewFile,
) -> Result<ReviewFile, String> {
    with_review_lock(root, id, || {
        validate_protected_reviews(root, id, &incoming.entries)?;
        let merged = merge_reviews(list_reviews(root, id)?, incoming);
        write_reviews(root, id, &merged)?;
        Ok(merged)
    })
}

const MAX_ENCRYPTED_REVIEW_BYTES: usize = 128 * 1024;

fn review_content(entry: &ReviewEntry) -> [&str; 4] {
    [&entry.quote, &entry.body, &entry.markdown, entry.resolution_note.as_deref().unwrap_or("")]
}

fn validate_protected_reviews(root: &Path, id: &str, entries: &[ReviewEntry]) -> Result<(), String> {
    if !entries.iter().flat_map(review_content).any(|value| !value.is_empty()) { return Ok(()); }
    let Some(path) = find_page_file(root, id) else { return Ok(()); };
    if !is_encrypted_markdown(&read_stored_page(root, &path)?.markdown) { return Ok(()); }
    for value in entries.iter().flat_map(review_content).filter(|value| !value.is_empty()) {
        if !is_encrypted_markdown(value) { return Err("加密页面的讨论内容需要先解锁并加密后保存".into()); }
        if value.len() > MAX_ENCRYPTED_REVIEW_BYTES { return Err("加密讨论内容不能超过 128 KiB".into()); }
    }
    Ok(())
}

fn review_content_limit(value: &str, plaintext_limit: usize) -> bool {
    value.len() <= if is_encrypted_markdown(value) { MAX_ENCRYPTED_REVIEW_BYTES } else { plaintext_limit }
}

pub fn change_entry(
    before: Option<&Page>,
    after: Option<&Page>,
    forced_type: Option<&str>,
) -> Result<Option<ReviewEntry>, String> {
    if CONTEXT.with(|slot| slot.borrow().replication) {
        return Ok(None);
    }
    if let (Some(before), Some(after)) = (before, after) {
        if !page_has_changed(before, after) {
            return Ok(None);
        }
    }
    let page = after.or(before).ok_or("缺少变更页面")?;
    let event_type = forced_type
        .map(str::to_owned)
        .or_else(|| CONTEXT.with(|slot| slot.borrow().event_type.clone()))
        .unwrap_or_else(|| {
            match (before, after) {
                (None, _) => "create",
                (_, None) => "purge",
                (Some(before), Some(after)) if before.deleted_at != after.deleted_at => {
                    if after.deleted_at.is_some() {
                        "trash"
                    } else {
                        "restore"
                    }
                }
                _ => "update",
            }
            .into()
        });
    let origin = current_origin();
    let fields = [
        "title",
        "icon",
        "parentId",
        "sortKey",
        "markdown",
        "tags",
        "deletedAt",
        "createdAt",
    ];
    let previous = serde_json::to_value(before).map_err(|error| error.to_string())?;
    let next = serde_json::to_value(after).map_err(|error| error.to_string())?;
    Ok(Some(ReviewEntry {
        id: format!("chg_{}", revision_id()),
        at: now(),
        actor: origin.actor.clone(),
        kind: "change".into(),
        status: "applied".into(),
        title: page.title.clone(),
        origin: Some(origin),
        event_type,
        page_id: page.id.clone(),
        revision_id: CONTEXT.with(|slot| slot.borrow().revision_id.clone()),
        changed_fields: fields
            .into_iter()
            .filter(|field| previous[*field] != next[*field])
            .map(str::to_owned)
            .collect(),
        base_updated_at: before
            .map(|page| page.updated_at.clone())
            .unwrap_or_default(),
        updated_at: after
            .map(|page| page.updated_at.clone())
            .unwrap_or_default(),
        ..ReviewEntry::default()
    }))
}
pub fn record_change(
    root: &Path,
    before: Option<&Page>,
    after: Option<&Page>,
    forced_type: Option<&str>,
) -> Result<(), String> {
    if let Some(entry) = change_entry(before, after, forced_type)? {
        let page_id = entry.page_id.clone();
        merge_review_file(
            root,
            &page_id,
            ReviewFile {
                entries: vec![entry],
            },
        )?;
    }
    Ok(())
}
pub fn is_replication() -> bool {
    CONTEXT.with(|slot| slot.borrow().replication)
}

fn signal_rank(status: &str) -> u8 {
    match status {
        "resolved" => 1,
        "adopted" => 2,
        "withdrawn" => 3,
        _ => 0,
    }
}
fn rank(status: &str) -> u8 {
    match status {
        "final" => 2,
        "kept" | "dropped" => 1,
        _ => 0,
    }
}
pub fn merge_reviews(mut current: ReviewFile, incoming: ReviewFile) -> ReviewFile {
    for entry in incoming.entries {
        if let Some(previous) = current.entries.iter_mut().find(|item| item.id == entry.id) {
            if entry.kind == "opinion" {
                let stamp = |item: &ReviewEntry| {
                    if item.updated_at.is_empty() {
                        item.at.clone()
                    } else {
                        item.updated_at.clone()
                    }
                };
                if signal_rank(&entry.status) > signal_rank(&previous.status)
                    || (signal_rank(&entry.status) == signal_rank(&previous.status)
                        && stamp(&entry) > stamp(previous))
                {
                    *previous = entry;
                }
            } else if entry.kind == "version" {
                if rank(&entry.status) > rank(&previous.status) {
                    let actor = if entry.actor != "另一端" && !entry.actor.is_empty() {
                        entry.actor.clone()
                    } else {
                        previous.actor.clone()
                    };
                    *previous = entry;
                    previous.actor = actor;
                } else if previous.actor == "另一端"
                    && entry.actor != "另一端"
                    && !entry.actor.is_empty()
                {
                    previous.actor = entry.actor;
                }
            }
        } else {
            current.entries.push(entry);
        }
    }
    current.entries.sort_by(|a, b| a.at.cmp(&b.at));
    current
}
pub fn add_signal(
    root: &Path,
    page_id: &str,
    id: &str,
    actor: &str,
    opinion_kind: &str,
    quote: &str,
    body: &str,
    base_updated_at: &str,
    reply_to: Option<&str>,
    origin: Option<ChangeOrigin>,
    at: Option<&str>,
) -> Result<ReviewFile, String> {
    with_review_lock(root, page_id, || {
        if !matches!(
            opinion_kind,
            "objection" | "correction" | "support" | "note"
        ) {
            return Err("意见类型无效".into());
        }
        if id.is_empty()
            || id.len() > 160
            || body.trim().is_empty()
            || !review_content_limit(body, 100_000)
            || !review_content_limit(quote, 100_000)
        {
            return Err("修改意见不完整".into());
        }
        let ws = crate::LocalWorkspace::open(root, None)?;
        if ws.get_by_id(page_id)?.is_none() {
            return Err("页面不存在".into());
        }
        let mut file = list_reviews(root, page_id)?;
        if let Some(item) = file.entries.iter().find(|item| item.id == id) {
            if item.kind != "opinion" {
                return Err("记录ID已被其他变更占用".into());
            }
            validate_protected_reviews(root, page_id, &[ReviewEntry { quote: quote.into(), body: body.into(), ..Default::default() }])?;
            return Ok(file);
        }
        if reply_to.is_some_and(|id| {
            !file
                .entries
                .iter()
                .any(|entry| entry.id == id && entry.kind == "opinion")
        }) {
            return Err("回复的意见不存在".into());
        }
        let stamp = at.map(str::to_owned).unwrap_or_else(now);
        file.entries.push(ReviewEntry {
            id: id.into(),
            at: stamp.clone(),
            updated_at: stamp,
            actor: origin
                .as_ref()
                .map(|value| value.actor.clone())
                .unwrap_or_else(|| actor.to_owned()),
            origin,
            kind: "opinion".into(),
            page_id: page_id.into(),
            status: "open".into(),
            quote: quote.into(),
            body: if is_encrypted_markdown(body) { body } else { body.trim() }.into(),
            opinion_kind: opinion_kind.into(),
            base_updated_at: base_updated_at.into(),
            reply_to: reply_to.map(str::to_owned),
            ..ReviewEntry::default()
        });
        write_reviews(root, page_id, &file)?;
        Ok(file)
    })
}
pub fn resolve_signal(
    root: &Path,
    page_id: &str,
    id: &str,
    status: &str,
    note: Option<&str>,
    applied_updated_at: Option<&str>,
    origin: Option<ChangeOrigin>,
) -> Result<ReviewFile, String> {
    with_review_lock(root, page_id, || {
        if !matches!(status, "resolved" | "adopted" | "withdrawn") {
            return Err("意见状态无效".into());
        }
        let mut file = list_reviews(root, page_id)?;
        let entry = file
            .entries
            .iter_mut()
            .find(|entry| entry.kind == "opinion" && entry.id == id)
            .ok_or("意见不存在")?;
        if signal_rank(status) < signal_rank(&entry.status) {
            return Err("已处理意见不能回退；继续讨论请新建意见或回复".into());
        }
        if status == "adopted" {
            let page = crate::LocalWorkspace::open(root, None)?
                .get_by_id(page_id)?
                .ok_or("页面不存在")?;
            if entry.base_updated_at.is_empty()
                || page.updated_at == entry.base_updated_at
                || applied_updated_at != Some(page.updated_at.as_str())
            {
                return Err("采纳前请先保存实际修改，再按当前页面版本确认".into());
            }
        }
        entry.status = status.into();
        entry.updated_at = now();
        entry.resolution_note = note.map(str::to_owned);
        entry.applied_updated_at = applied_updated_at.map(str::to_owned);
        if let Some(origin) = origin {
            entry.resolution_origin = Some(origin);
        }
        write_reviews(root, page_id, &file)?;
        Ok(file)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn origin(id: &str) -> ChangeOrigin {
        ChangeOrigin {
            client_id: "test-agent".into(),
            client_name: "测试客户端".into(),
            client_version: "1".into(),
            device_id: id.into(),
            device_name: format!("Device {id}"),
            platform: "test".into(),
            actor: "Test Agent".into(),
            user_id: None,
        }
    }
    fn fixture() -> (std::path::PathBuf, crate::LocalWorkspace, Page) {
        fixture_with_markdown("# Changes\n\nfirst".into())
    }
    fn fixture_with_markdown(markdown: String) -> (std::path::PathBuf, crate::LocalWorkspace, Page) {
        let root = std::env::temp_dir().join(format!("tie-change-test-{}", revision_id()));
        let ws = crate::LocalWorkspace::init(&root, "src_test").unwrap();
        let page = Page {
            id: "pg_change".into(),
            title: "Changes".into(),
            icon: String::new(),
            parent_id: None,
            sort_key: 0,
            markdown,
            tags: vec![],
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
            deleted_at: None,
            storage_source_id: "src_test".into(),
            storage_source_ids: vec!["src_test".into()],
        };
        let saved = with_change_context(origin("A"), None, false, || ws.save_full_page(page, None))
            .unwrap();
        (root, ws, saved)
    }
    #[test]
    fn real_save_noop_and_replication_keep_one_origin_event_per_actual_edit() {
        let (root, ws, page) = fixture();
        with_change_context(origin("A"), None, false, || {
            ws.save_full_page(page.clone(), None)
        })
        .unwrap();
        assert_eq!(list_reviews(&root, &page.id).unwrap().entries.len(), 1);
        let mut next = page.clone();
        next.markdown.push_str("\nsecond");
        let next = with_change_context(origin("B"), None, false, || {
            ws.save_full_page(next, Some(&page.updated_at))
        })
        .unwrap();
        assert_ne!(next.updated_at, page.updated_at);
        let file = list_reviews(&root, &page.id).unwrap();
        assert_eq!(file.entries.len(), 2);
        let event = file
            .entries
            .iter()
            .find(|event| event.origin.as_ref().unwrap().device_id == "B")
            .unwrap();
        assert_eq!(event.changed_fields, vec!["markdown"]);
        let mut remote = next;
        remote.markdown.push_str("\nreplica");
        remote.updated_at = "2027-01-01T00:00:00.000Z".into();
        let saved = with_change_context(origin("remote"), None, true, || {
            ws.save_full_page(remote, None)
        })
        .unwrap();
        assert_eq!(saved.updated_at, "2027-01-01T00:00:00.000Z");
        assert_eq!(list_reviews(&root, &page.id).unwrap().entries.len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn signal_adoption_requires_saved_version_and_withdrawal_cannot_be_revived() {
        let (root, ws, page) = fixture();
        let initial = add_signal(
            &root,
            &page.id,
            "op_test",
            "Test",
            "correction",
            "first",
            "change it",
            &page.updated_at,
            None,
            Some(origin("A")),
            None,
        )
        .unwrap();
        assert!(resolve_signal(
            &root,
            &page.id,
            "op_test",
            "adopted",
            None,
            Some(&page.updated_at),
            Some(origin("B"))
        )
        .is_err());
        let mut edited = page.clone();
        edited.markdown.push_str("\nchanged");
        let edited = ws.save_full_page(edited, Some(&page.updated_at)).unwrap();
        let adopted = resolve_signal(
            &root,
            &page.id,
            "op_test",
            "adopted",
            None,
            Some(&edited.updated_at),
            Some(origin("B")),
        )
        .unwrap();
        let item = adopted
            .entries
            .iter()
            .find(|entry| entry.id == "op_test")
            .unwrap();
        assert_eq!(item.origin.as_ref().unwrap().device_id, "A");
        assert_eq!(item.resolution_origin.as_ref().unwrap().device_id, "B");
        resolve_signal(
            &root,
            &page.id,
            "op_test",
            "withdrawn",
            Some("done"),
            None,
            Some(origin("A")),
        )
        .unwrap();
        assert!(resolve_signal(
            &root,
            &page.id,
            "op_test",
            "resolved",
            None,
            None,
            Some(origin("B"))
        )
        .is_err());
        let merged = merge_review_file(&root, &page.id, initial).unwrap();
        assert_eq!(
            merged
                .entries
                .iter()
                .find(|entry| entry.id == "op_test")
                .unwrap()
                .status,
            "withdrawn"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn concurrent_real_review_writes_preserve_every_event_and_extra_fields() {
        let (root, _, page) = fixture();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
        let handles = (0..16)
            .map(|i| {
                let root = root.clone();
                let id = page.id.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut event = ReviewEntry {
                        id: format!("chg_{i}"),
                        kind: "change".into(),
                        page_id: id.clone(),
                        at: now(),
                        ..Default::default()
                    };
                    event
                        .extra
                        .insert("pageUpdatedAt".into(), serde_json::json!("preserved"));
                    barrier.wait();
                    merge_review_file(
                        &root,
                        &id,
                        ReviewFile {
                            entries: vec![event],
                        },
                    )
                    .unwrap();
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }
        let file = list_reviews(&root, &page.id).unwrap();
        assert_eq!(file.entries.len(), 17);
        assert_eq!(
            file.entries
                .iter()
                .filter(|event| event.extra.contains_key("pageUpdatedAt"))
                .count(),
            16
        );
        assert!(!review_path(&root, &page.id)
            .unwrap()
            .with_extension("lock")
            .exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn envelope(value: &str) -> String {
        format!("{}\n{{\"ciphertext\":\"{value}\"}}\n-----END TIE ENCRYPTED MARKDOWN-----\n", crate::ENCRYPTED_MARKDOWN_PREFIX)
    }

    #[test]
    fn protected_discussions_keep_opaque_content_and_signal_state_semantics() {
        let (root, ws, page) = fixture_with_markdown(envelope("opaque-page"));
        let canary = "fixture-private-discussion-rejected-63912";
        assert!(add_signal(&root, &page.id, "op_plain", "Test", "support", "", canary,
            &page.updated_at, None, None, None).unwrap_err().contains("先解锁并加密"));
        let body = envelope("opaque-opinion");
        assert!(add_signal(&root, &page.id, "op_quote", "Test", "support", canary, &body,
            &page.updated_at, None, None, None).is_err());
        let initial = add_signal(&root, &page.id, "op_private", "Test", "correction", "", &body,
            &page.updated_at, None, Some(origin("A")), None).unwrap();
        assert_eq!(initial.entries.iter().find(|entry| entry.id == "op_private").unwrap().body, body);
        let reply = add_signal(&root, &page.id, "op_reply", "Test", "support", "", &envelope("opaque-reply"),
            &page.updated_at, Some("op_private"), None, None).unwrap();
        assert_eq!(reply.entries.iter().find(|entry| entry.id == "op_reply").unwrap().reply_to.as_deref(), Some("op_private"));
        assert!(resolve_signal(&root, &page.id, "op_private", "resolved", Some(canary), None, None).is_err());
        assert!(resolve_signal(&root, &page.id, "op_private", "adopted", None, Some(&page.updated_at), None).is_err());
        let mut edited = page.clone();
        edited.markdown = envelope("opaque-edited-page");
        let edited = ws.save_full_page(edited, Some(&page.updated_at)).unwrap();
        let note = envelope("opaque-resolution");
        let adopted = resolve_signal(&root, &page.id, "op_private", "adopted", Some(&note), Some(&edited.updated_at), Some(origin("B"))).unwrap();
        let signal = adopted.entries.iter().find(|entry| entry.id == "op_private").unwrap();
        assert_eq!(signal.status, "adopted");
        assert_eq!(signal.resolution_note.as_deref(), Some(note.as_str()));
        resolve_signal(&root, &page.id, "op_private", "withdrawn", None, None, None).unwrap();
        assert!(resolve_signal(&root, &page.id, "op_private", "resolved", None, None, None).is_err());
        let merged = merge_review_file(&root, &page.id, initial).unwrap();
        assert_eq!(merged.entries.iter().find(|entry| entry.id == "op_private").unwrap().status, "withdrawn");
        assert!(add_signal(&root, &page.id, "op_private", "Test", "support", "", canary, "", None, None, None).is_err());

        for field in ["body", "quote", "markdown", "resolution_note"] {
            let before = fs::read(review_path(&root, &page.id).unwrap()).unwrap();
            let mut entry = ReviewEntry { id: format!("bad_{field}"), kind: "opinion".into(), ..Default::default() };
            match field { "body" => entry.body = canary.into(), "quote" => entry.quote = canary.into(),
                "markdown" => entry.markdown = canary.into(), _ => entry.resolution_note = Some(canary.into()) }
            let file = ReviewFile { entries: vec![entry] };
            assert!(merge_review_file(&root, &page.id, file.clone()).is_err());
            assert!(write_reviews(&root, &page.id, &file).is_err());
            assert_eq!(fs::read(review_path(&root, &page.id).unwrap()).unwrap(), before);
        }
        assert!(!fs::read_to_string(review_path(&root, &page.id).unwrap()).unwrap().contains(canary));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn encrypted_review_overhead_has_a_bounded_allowance_without_changing_plain_limits() {
        let (root, _, page) = fixture();
        assert!(add_signal(&root, &page.id, "op_long_plain", "Test", "support", "", &"x".repeat(100001),
            "", None, None, None).is_err());
        fs::remove_dir_all(root).unwrap();
        let (root, _, page) = fixture_with_markdown(envelope("opaque-page"));
        let body = envelope(&"a".repeat(105000));
        let file = add_signal(&root, &page.id, "op_overhead", "Test", "support", "", &body,
            "", None, None, None).unwrap();
        assert_eq!(file.entries.iter().find(|entry| entry.id == "op_overhead").unwrap().body, body);
        assert!(add_signal(&root, &page.id, "op_too_large", "Test", "support", "", &envelope(&"a".repeat(MAX_ENCRYPTED_REVIEW_BYTES)),
            "", None, None, None).is_err());
        let version = ReviewEntry { id: "rv_private".into(), kind: "version".into(), markdown: envelope("opaque-version"), ..Default::default() };
        merge_review_file(&root, &page.id, ReviewFile { entries: vec![version] }).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
