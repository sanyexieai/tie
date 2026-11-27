//! Whole-page protection transitions include history, discussion and page assets.
use crate::{
    changes::{self, ReviewFile},
    encryption::{decrypt_markdown, encrypt_markdown, protect_reviews, reveal_reviews},
    io::{list_page_revisions_from_root, read_page_revision_from_root},
    page::{frontmatter, is_encrypted_markdown, page_meta_text, revision_id},
    paths::{
        find_page_file, page_asset_dir, page_meta_path, revision_dir, sanitize_asset_name,
        workspace_relative,
    },
    LocalWorkspace, Page,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionRevision {
    pub id: String,
    pub page: Page,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionAsset {
    pub name: String,
    #[serde(with = "asset_data")]
    pub data: Vec<u8>,
}

mod asset_data {
    use super::*;
    pub fn serialize<S: serde::Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(bytes))
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<u8>, D::Error> {
        STANDARD
            .decode(String::deserialize(deserializer)?)
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionBundle {
    pub page: Page,
    pub revisions: Vec<ProtectionRevision>,
    pub reviews: ReviewFile,
    pub assets: Vec<ProtectionAsset>,
    pub snapshot: String,
}

impl LocalWorkspace {
    pub fn protection_bundle(&self, id_or_title: &str) -> Result<ProtectionBundle, String> {
        let page = self.resolve(id_or_title)?.ok_or("页面不存在")?;
        let revisions = list_page_revisions_from_root(self.root(), &page.id)?
            .into_iter()
            .map(|revision| {
                Ok(ProtectionRevision {
                    page: read_page_revision_from_root(self.root(), &page.id, &revision.id)?,
                    id: revision.id,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let reviews = changes::list_reviews(self.root(), &page.id)?;
        let directory = page_asset_dir(self.root(), &page.id);
        let mut assets = Vec::new();
        if directory.exists() {
            for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                    return Err("页面附件目录包含不支持的文件类型".into());
                }
                assets.push(ProtectionAsset {
                    name: entry
                        .file_name()
                        .into_string()
                        .map_err(|_| "附件文件名无效")?,
                    data: fs::read(entry.path()).map_err(|e| e.to_string())?,
                });
            }
        }
        assets.sort_by(|a, b| a.name.cmp(&b.name));
        let mut bundle = ProtectionBundle {
            page,
            revisions,
            reviews,
            assets,
            snapshot: String::new(),
        };
        bundle.snapshot = bundle_snapshot(&bundle)?;
        Ok(bundle)
    }

    /// Replaces a prepared client-side transition without receiving its password.
    pub fn replace_page_protection(
        &self,
        bundle: ProtectionBundle,
        expected_updated_at: Option<&str>,
    ) -> Result<Page, String> {
        let id = bundle.page.id.clone();
        crate::io::with_page_lock(self.root(), &id, || {
            changes::with_review_lock(self.root(), &id, || {
                self.replace_page_protection_locked(bundle, expected_updated_at)
            })
        })
    }

    fn replace_page_protection_locked(
        &self,
        mut bundle: ProtectionBundle,
        expected_updated_at: Option<&str>,
    ) -> Result<Page, String> {
        let previous = self.protection_bundle(&bundle.page.id)?;
        if bundle.snapshot != previous.snapshot
            || expected_updated_at.is_some_and(|expected| expected != previous.page.updated_at)
        {
            return Err("页面、历史或讨论已更新，请重新载入后再转换".into());
        }
        validate_transition(&previous, &bundle)?;
        let encrypted = is_encrypted_markdown(&bundle.page.markdown);
        let mut archived = previous.page.clone();
        archived.markdown = bundle.page.markdown.clone();
        bundle.revisions.push(ProtectionRevision {
            id: revision_id(),
            page: archived,
        });
        bundle.page.updated_at = crate::api::next_updated_at(Some(&previous.page.updated_at));
        if let Some(change) = changes::change_entry(
            Some(&previous.page),
            Some(&bundle.page),
            Some(if encrypted { "encrypt" } else { "decrypt" }),
        )? {
            bundle.reviews.entries.push(change);
        }
        let files = transition_files(self.root(), &previous, &bundle)?;
        // All crypto and source checks precede writes; originals stay in memory for rollback.
        if self.protection_bundle(&bundle.page.id)?.snapshot != previous.snapshot {
            return Err("页面、历史或讨论已更新，请重新载入后再转换".into());
        }
        install_files(files)?;
        Ok(bundle.page)
    }

    pub fn convert_page_protection(
        &self,
        id_or_title: &str,
        password: &str,
        encrypted: bool,
        expected_updated_at: Option<&str>,
    ) -> Result<Page, String> {
        let bundle =
            transform_protection_bundle(self.protection_bundle(id_or_title)?, password, encrypted)?;
        self.replace_page_protection(bundle, expected_updated_at)
    }
}

pub fn transform_protection_bundle(
    mut bundle: ProtectionBundle,
    password: &str,
    encrypted: bool,
) -> Result<ProtectionBundle, String> {
    if is_encrypted_markdown(&bundle.page.markdown) == encrypted {
        return Err(if encrypted {
            "页面已经加密"
        } else {
            "页面已经是普通页面"
        }
        .into());
    }
    if encrypted {
        let mut used = BTreeSet::new();
        let assets: BTreeMap<String, Vec<u8>> = bundle
            .assets
            .iter()
            .map(|asset| (asset.name.clone(), asset.data.clone()))
            .collect();
        bundle.page.markdown = encrypt_markdown(
            &inline_assets(&bundle.page.markdown, &bundle.page.id, &assets, &mut used)?,
            password,
        )?;
        for revision in &mut bundle.revisions {
            let markdown = if is_encrypted_markdown(&revision.page.markdown) {
                decrypt_markdown(&revision.page.markdown, password)?
            } else {
                revision.page.markdown.clone()
            };
            revision.page.markdown = encrypt_markdown(
                &inline_assets(&markdown, &bundle.page.id, &assets, &mut used)?,
                password,
            )?;
        }
        for entry in &mut bundle.reviews.entries {
            for value in [&mut entry.quote, &mut entry.body, &mut entry.markdown] {
                if !value.is_empty() && !is_encrypted_markdown(value) {
                    *value = inline_assets(value, &bundle.page.id, &assets, &mut used)?;
                }
            }
            if let Some(note) = &mut entry.resolution_note {
                if !note.is_empty() && !is_encrypted_markdown(note) {
                    *note = inline_assets(note, &bundle.page.id, &assets, &mut used)?;
                }
            }
        }
        bundle.reviews = protect_reviews(bundle.reviews, password)?;
        bundle.assets = bundle
            .assets
            .into_iter()
            .filter(|asset| !used.contains(&asset.name))
            .map(|asset| {
                Ok(ProtectionAsset {
                    name: asset.name,
                    data: encrypt_markdown(&STANDARD.encode(asset.data), password)?.into_bytes(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
    } else {
        bundle.page.markdown = decrypt_markdown(&bundle.page.markdown, password)?;
        for revision in &mut bundle.revisions {
            if is_encrypted_markdown(&revision.page.markdown) {
                revision.page.markdown = decrypt_markdown(&revision.page.markdown, password)?;
            }
        }
        bundle.reviews = reveal_reviews(bundle.reviews, password)?;
        for asset in &mut bundle.assets {
            if let Ok(encrypted) = std::str::from_utf8(&asset.data) {
                if is_encrypted_markdown(encrypted) {
                    asset.data = STANDARD
                        .decode(decrypt_markdown(encrypted, password)?)
                        .map_err(|_| "加密附件格式无效")?;
                }
            }
        }
    }
    Ok(bundle)
}

fn bundle_snapshot(bundle: &ProtectionBundle) -> Result<String, String> {
    let mut source = bundle.clone();
    source.snapshot.clear();
    Ok(
        Sha256::digest(serde_json::to_vec(&source).map_err(|e| e.to_string())?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

fn same_metadata(before: &Page, after: &Page) -> bool {
    let mut copy = after.clone();
    copy.markdown = before.markdown.clone();
    serde_json::to_value(before).ok() == serde_json::to_value(copy).ok()
}

fn validate_transition(before: &ProtectionBundle, after: &ProtectionBundle) -> Result<(), String> {
    let encrypted = is_encrypted_markdown(&after.page.markdown);
    if encrypted == is_encrypted_markdown(&before.page.markdown) {
        return Err("页面保护状态没有变化".into());
    }
    if !same_metadata(&before.page, &after.page) {
        return Err("转换不能改变页面身份或元数据，请先保存页面".into());
    }
    if before.revisions.len() != after.revisions.len() {
        return Err("转换不能丢弃历史版本".into());
    }
    let previous_revisions: BTreeMap<&str, &Page> = before
        .revisions
        .iter()
        .map(|revision| (revision.id.as_str(), &revision.page))
        .collect();
    let mut seen = BTreeSet::new();
    for revision in &after.revisions {
        let previous = previous_revisions
            .get(revision.id.as_str())
            .ok_or("转换包含未知历史版本")?;
        if !seen.insert(&revision.id)
            || !same_metadata(previous, &revision.page)
            || is_encrypted_markdown(&revision.page.markdown) != encrypted
        {
            return Err("历史版本转换不完整".into());
        }
    }
    let previous_reviews: BTreeMap<&str, _> = before
        .reviews
        .entries
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();
    if previous_reviews.len() != after.reviews.entries.len() {
        return Err("转换不能丢弃讨论或变更记录".into());
    }
    let mut seen = BTreeSet::new();
    for entry in &after.reviews.entries {
        let previous = previous_reviews
            .get(entry.id.as_str())
            .ok_or("转换包含未知讨论记录")?;
        let mut metadata = entry.clone();
        metadata.quote = previous.quote.clone();
        metadata.body = previous.body.clone();
        metadata.markdown = previous.markdown.clone();
        metadata.resolution_note = previous.resolution_note.clone();
        if !seen.insert(&entry.id) || &metadata != *previous {
            return Err("转换不能改变讨论元数据".into());
        }
        if encrypted {
            if ((entry.kind == "opinion" || !entry.body.is_empty())
                && !is_encrypted_markdown(&entry.body))
                || !entry.quote.is_empty()
                || (!entry.markdown.is_empty() && !is_encrypted_markdown(&entry.markdown))
                || entry
                    .resolution_note
                    .as_ref()
                    .is_some_and(|note| !note.is_empty() && !is_encrypted_markdown(note))
            {
                return Err("讨论内容未完整加密".into());
            }
        } else if [
            &entry.body,
            &entry.markdown,
            entry.resolution_note.as_deref().unwrap_or(""),
        ]
        .into_iter()
        .any(|value| is_encrypted_markdown(value))
        {
            return Err("讨论内容未完整解密".into());
        }
    }
    let previous_assets: BTreeSet<&str> = before
        .assets
        .iter()
        .map(|asset| asset.name.as_str())
        .collect();
    let mut seen = BTreeSet::new();
    for asset in &after.assets {
        sanitize_asset_name(&asset.name)?;
        if !seen.insert(&asset.name) || !previous_assets.contains(asset.name.as_str()) {
            return Err("转换包含未知附件".into());
        }
        if encrypted && !std::str::from_utf8(&asset.data).is_ok_and(is_encrypted_markdown) {
            return Err("附件未完整加密".into());
        }
    }
    let mut referenced = BTreeSet::new();
    if encrypted {
        for body in std::iter::once(before.page.markdown.as_str())
            .chain(
                before
                    .revisions
                    .iter()
                    .map(|revision| revision.page.markdown.as_str()),
            )
            .chain(before.reviews.entries.iter().flat_map(|entry| {
                [
                    entry.quote.as_str(),
                    entry.body.as_str(),
                    entry.markdown.as_str(),
                    entry.resolution_note.as_deref().unwrap_or(""),
                ]
            }))
        {
            for (name, _) in asset_references(body, &before.page.id) {
                referenced.insert(name.to_owned());
            }
        }
    }
    let expected: BTreeSet<&str> = previous_assets
        .into_iter()
        .filter(|name| !referenced.contains(*name))
        .collect();
    let supplied: BTreeSet<&str> = after
        .assets
        .iter()
        .map(|asset| asset.name.as_str())
        .collect();
    if expected != supplied {
        return Err("转换不能丢弃未内嵌的附件".into());
    }
    Ok(())
}

fn asset_references<'a>(markdown: &'a str, page_id: &str) -> Vec<(&'a str, usize)> {
    let prefix = format!("tie://asset/{page_id}/");
    markdown
        .match_indices(&prefix)
        .map(|(offset, _)| {
            let after = &markdown[offset + prefix.len()..];
            let end = after
                .find(|c: char| !c.is_ascii_alphanumeric() && !"._-".contains(c))
                .unwrap_or(after.len());
            (&after[..end], offset)
        })
        .collect()
}

fn inline_assets(
    markdown: &str,
    page_id: &str,
    assets: &BTreeMap<String, Vec<u8>>,
    used: &mut BTreeSet<String>,
) -> Result<String, String> {
    let prefix = format!("tie://asset/{page_id}/");
    let mut output = String::new();
    let mut rest = markdown;
    while let Some(offset) = rest.find(&prefix) {
        output.push_str(&rest[..offset]);
        let after = &rest[offset + prefix.len()..];
        let end = after
            .find(|c: char| !c.is_ascii_alphanumeric() && !"._-".contains(c))
            .unwrap_or(after.len());
        let name = &after[..end];
        let data = assets
            .get(name)
            .ok_or_else(|| format!("无法读取页面图片附件：{name}"))?;
        let mime = raster_mime(data)
            .ok_or_else(|| format!("附件 {name} 不是支持的安全图片，请移除引用后再加密"))?;
        output.push_str(&format!("data:{mime};base64,{}", STANDARD.encode(data)));
        used.insert(name.into());
        rest = &after[end..];
    }
    output.push_str(rest);
    Ok(output)
}

fn raster_mime(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else if data.starts_with(b"BM") {
        Some("image/bmp")
    } else if data.starts_with(b"\0\0\x01\0") {
        Some("image/x-icon")
    } else {
        None
    }
}

struct Replacement {
    path: PathBuf,
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
}

fn transition_files(
    root: &Path,
    before: &ProtectionBundle,
    after: &ProtectionBundle,
) -> Result<Vec<Replacement>, String> {
    let page_path = find_page_file(root, &after.page.id).ok_or("页面不存在")?;
    let mut paths = BTreeMap::<PathBuf, Option<Vec<u8>>>::new();
    paths.insert(
        page_path.clone(),
        Some(after.page.markdown.as_bytes().to_vec()),
    );
    paths.insert(
        page_meta_path(root, &after.page.id),
        Some(page_meta_text(&after.page, &workspace_relative(root, &page_path)?)?.into_bytes()),
    );
    for revision in &after.revisions {
        paths.insert(
            revision_dir(root, &after.page.id).join(format!("{}.md", revision.id)),
            Some(frontmatter(&revision.page).into_bytes()),
        );
    }
    paths.insert(
        root.join(".tie/reviews")
            .join(format!("{}.json", after.page.id)),
        Some(serde_json::to_vec_pretty(&after.reviews).map_err(|e| e.to_string())?),
    );
    for asset in &before.assets {
        paths.insert(page_asset_dir(root, &after.page.id).join(&asset.name), None);
    }
    for asset in &after.assets {
        paths.insert(
            page_asset_dir(root, &after.page.id).join(&asset.name),
            Some(asset.data.clone()),
        );
    }
    paths
        .into_iter()
        .map(|(path, after)| {
            let before = match fs::read(&path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.to_string()),
            };
            Ok(Replacement {
                path,
                before,
                after,
            })
        })
        .collect()
}

fn install_files(files: Vec<Replacement>) -> Result<(), String> {
    for (index, file) in files.iter().enumerate() {
        if let Err(error) = install_file(&file.path, file.after.as_deref()) {
            let mut rollback_failed = false;
            for previous in files[..index].iter().rev() {
                rollback_failed |=
                    install_file(&previous.path, previous.before.as_deref()).is_err();
            }
            return Err(if rollback_failed {
                format!("转换写入失败且部分文件无法恢复，请从备份恢复：{error}")
            } else {
                format!("转换失败，原页面已保留：{error}")
            });
        }
    }
    Ok(())
}

fn install_file(path: &Path, bytes: Option<&[u8]>) -> Result<(), String> {
    let Some(bytes) = bytes else {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        };
    };
    fs::create_dir_all(path.parent().ok_or("页面路径无效")?).map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", revision_id()));
    fs::write(&temporary, bytes).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{changes::ReviewEntry, WritePageInput};

    fn workspace(name: &str) -> (PathBuf, LocalWorkspace, Page) {
        let root = std::env::temp_dir().join(format!("tie-protection-{name}-{}", revision_id()));
        let ws = LocalWorkspace::init(&root, "local:protection-test").unwrap();
        let result = ws
            .write_page(WritePageInput {
                title: Some("Protection fixture".into()),
                markdown: Some("# Fixture\n\nfixture-old-private-body\n".into()),
                tags: Some(vec!["test".into()]),
                ..Default::default()
            })
            .unwrap();
        let page = ws.get_by_id(&result.page.id).unwrap().unwrap();
        (root, ws, page)
    }

    fn all_bytes(root: &Path) -> Vec<u8> {
        let mut out = Vec::new();
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                out.extend(all_bytes(&path));
            } else {
                out.extend(fs::read(path).unwrap());
            }
        }
        out
    }

    #[test]
    fn converts_real_page_history_reviews_and_assets_both_directions() {
        let (root, ws, mut page) = workspace("roundtrip");
        let png = b"\x89PNG\r\n\x1a\nfixture-only-png";
        let directory = page_asset_dir(&root, &page.id);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("history.png"), png).unwrap();
        fs::write(directory.join("unused.bin"), b"fixture-unused-secret-bytes").unwrap();
        page.markdown.push_str(&format!(
            "\n![image](tie://asset/{}/history.png)\n",
            page.id
        ));
        crate::io::save_page_to_root(&root, page.clone(), None).unwrap();
        page.markdown = "# Fixture\n\nfixture-current-private-body\n".into();
        page = crate::io::save_page_to_root(&root, page, None).unwrap();
        let opinion = ReviewEntry {
            id: "opinion-fixture".into(),
            kind: "opinion".into(),
            status: "resolved".into(),
            quote: "fixture-quote-secret".into(),
            body: "fixture-reply-secret".into(),
            resolution_note: Some("fixture-resolution-secret".into()),
            ..Default::default()
        };
        let version = ReviewEntry {
            id: "version-fixture".into(),
            kind: "version".into(),
            markdown: "fixture-manual-version-secret".into(),
            ..Default::default()
        };
        changes::merge_review_file(
            &root,
            &page.id,
            ReviewFile {
                entries: vec![opinion.clone(), version.clone()],
            },
        )
        .unwrap();
        let original = ws.protection_bundle(&page.id).unwrap();
        let wire = serde_json::to_value(&original).unwrap();
        assert!(wire["assets"][0]["data"].is_string());
        let protected = ws
            .convert_page_protection(
                &page.id,
                "fixture-page-password",
                true,
                Some(&page.updated_at),
            )
            .unwrap();
        assert!(is_encrypted_markdown(&protected.markdown));
        assert_eq!(protected.id, page.id);
        assert_eq!(protected.tags, page.tags);
        assert_ne!(protected.updated_at, page.updated_at);
        let raw = String::from_utf8_lossy(&all_bytes(&root)).into_owned();
        for canary in [
            "fixture-current-private-body",
            "fixture-old-private-body",
            "fixture-quote-secret",
            "fixture-reply-secret",
            "fixture-resolution-secret",
            "fixture-manual-version-secret",
            "fixture-unused-secret-bytes",
            "fixture-only-png",
        ] {
            assert!(!raw.contains(canary), "plaintext remained: {canary}");
        }
        assert!(!directory.join("history.png").exists());
        let protected_bundle = ws.protection_bundle(&page.id).unwrap();
        assert_eq!(
            protected_bundle.revisions.len(),
            original.revisions.len() + 1
        );
        assert!(protected_bundle
            .revisions
            .iter()
            .all(|revision| is_encrypted_markdown(&revision.page.markdown)));
        assert!(protected_bundle
            .reviews
            .entries
            .iter()
            .any(|entry| entry.event_type == "encrypt"));
        let no_change = protected_bundle.snapshot.clone();
        assert!(ws
            .convert_page_protection(&page.id, "wrong-password", false, None)
            .is_err());
        assert_eq!(ws.protection_bundle(&page.id).unwrap().snapshot, no_change);
        let ordinary = ws
            .convert_page_protection(
                &page.id,
                "fixture-page-password",
                false,
                Some(&protected.updated_at),
            )
            .unwrap();
        assert_eq!(ordinary.markdown, page.markdown);
        let final_bundle = ws.protection_bundle(&page.id).unwrap();
        let restored = final_bundle
            .reviews
            .entries
            .iter()
            .find(|entry| entry.id == opinion.id)
            .unwrap();
        assert_eq!(restored, &opinion);
        assert!(final_bundle.reviews.entries.contains(&version));
        assert_eq!(
            fs::read(directory.join("unused.bin")).unwrap(),
            b"fixture-unused-secret-bytes"
        );
        assert!(final_bundle
            .revisions
            .iter()
            .any(|revision| revision.page.markdown.contains("data:image/png;base64,")));
        assert!(final_bundle
            .reviews
            .entries
            .iter()
            .any(|entry| entry.event_type == "decrypt"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_stale_discussions_missing_history_and_metadata_changes_before_writing() {
        let (root, ws, mut page) = workspace("snapshot");
        page.markdown.push_str("\nnew version\n");
        let page = crate::io::save_page_to_root(&root, page, None).unwrap();
        let original = ws.protection_bundle(&page.id).unwrap();
        let converted =
            transform_protection_bundle(original.clone(), "fixture-password", true).unwrap();
        let mut missing = converted.clone();
        missing.revisions.clear();
        assert!(ws
            .replace_page_protection(missing, None)
            .unwrap_err()
            .contains("历史"));
        let mut changed = converted.clone();
        changed.page.parent_id = Some("pg_foreign".into());
        assert!(ws
            .replace_page_protection(changed, None)
            .unwrap_err()
            .contains("元数据"));
        assert_eq!(
            ws.protection_bundle(&page.id).unwrap().snapshot,
            original.snapshot
        );
        changes::merge_review_file(
            &root,
            &page.id,
            ReviewFile {
                entries: vec![ReviewEntry {
                    id: "arrived-after-read".into(),
                    kind: "opinion".into(),
                    body: "new opinion".into(),
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        let before = all_bytes(&root);
        assert!(ws
            .replace_page_protection(converted, None)
            .unwrap_err()
            .contains("讨论已更新"));
        assert_eq!(all_bytes(&root), before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inlines_resolution_images_and_allows_authorized_recovery_of_legacy_plain_data() {
        let (root, ws, page) = workspace("legacy-and-notes");
        let assets = page_asset_dir(&root, &page.id);
        fs::create_dir_all(&assets).unwrap();
        fs::write(assets.join("note.png"), b"\x89PNG\r\n\x1a\nfixture-note-image").unwrap();
        changes::merge_review_file(&root, &page.id, ReviewFile { entries: vec![ReviewEntry {
            id: "image-note".into(), kind: "opinion".into(), body: "fixture-discussion-body".into(), resolution_note: Some(format!("![note](tie://asset/{}/note.png)", page.id)), ..Default::default()
        }] }).unwrap();
        ws.convert_page_protection(&page.id, "fixture-legacy-password", true, None).unwrap();
        assert!(!assets.join("note.png").exists());
        // Reproduce files left by an older client; normal encrypted writes reject this data.
        let mut reviews = changes::list_reviews(&root, &page.id).unwrap();
        reviews.entries.push(ReviewEntry { id: "old-plain".into(), kind: "opinion".into(), quote: "legacy quote".into(), body: "legacy body".into(), resolution_note: Some("legacy note".into()), ..Default::default() });
        fs::write(root.join(".tie/reviews").join(format!("{}.json", page.id)), serde_json::to_vec(&reviews).unwrap()).unwrap();
        fs::write(assets.join("legacy-raw.bin"), [0xff, 0, 0x42]).unwrap();
        let snapshot = ws.protection_bundle(&page.id).unwrap().snapshot;
        assert!(ws.convert_page_protection(&page.id, "wrong", false, None).is_err());
        assert_eq!(ws.protection_bundle(&page.id).unwrap().snapshot, snapshot);
        ws.convert_page_protection(&page.id, "fixture-legacy-password", false, None).unwrap();
        let recovered = ws.protection_bundle(&page.id).unwrap();
        assert!(recovered.reviews.entries.iter().find(|entry| entry.id == "image-note").unwrap().resolution_note.as_deref().unwrap().contains("data:image/png;base64,"));
        let legacy = recovered.reviews.entries.iter().find(|entry| entry.id == "old-plain").unwrap();
        assert_eq!(legacy.body, "legacy body");
        assert_eq!(legacy.quote, "legacy quote");
        assert_eq!(legacy.resolution_note.as_deref(), Some("legacy note"));
        assert_eq!(fs::read(assets.join("legacy-raw.bin")).unwrap(), [0xff, 0, 0x42]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_multi_file_install_restores_original_bytes_and_removes_new_files() {
        let root = std::env::temp_dir().join(format!("tie-protection-rollback-{}", revision_id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("original"), b"original-bytes").unwrap();
        fs::write(root.join("blocked"), b"file-not-directory").unwrap();
        let failure = install_files(vec![
            Replacement {
                path: root.join("original"),
                before: Some(b"original-bytes".to_vec()),
                after: Some(b"new-bytes".to_vec()),
            },
            Replacement {
                path: root.join("new"),
                before: None,
                after: Some(b"new-file".to_vec()),
            },
            Replacement {
                path: root.join("blocked/item"),
                before: None,
                after: Some(b"cannot-write".to_vec()),
            },
        ])
        .unwrap_err();
        assert!(failure.contains("原页面已保留"));
        assert_eq!(fs::read(root.join("original")).unwrap(), b"original-bytes");
        assert!(!root.join("new").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_in_flight_ordinary_save_cannot_restore_plaintext_during_conversion() {
        let (root, ws, mut page) = workspace("parallel-save");
        let converted = transform_protection_bundle(
            ws.protection_bundle(&page.id).unwrap(),
            "fixture-parallel-password",
            true,
        )
        .unwrap();
        page.markdown = "fixture-late-ordinary-secret".into();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let id = page.id.clone();
        let save_root = root.clone();
        let join = crate::io::with_page_lock(&root, &id, || {
            let join = std::thread::spawn(move || {
                started_tx.send(()).unwrap();
                done_tx
                    .send(crate::io::save_page_to_root(&save_root, page, None))
                    .unwrap();
            });
            started_rx.recv().unwrap();
            assert!(
                done_rx
                    .recv_timeout(std::time::Duration::from_millis(100))
                    .is_err(),
                "ordinary save completed while conversion owned the page lock"
            );
            changes::with_review_lock(&root, &id, || {
                ws.replace_page_protection_locked(converted, None)
            })?;
            Ok(join)
        })
        .unwrap();
        assert!(done_rx
            .recv()
            .unwrap()
            .unwrap_err()
            .contains("PROTECTION_REQUIRED"));
        join.join().unwrap();
        assert!(is_encrypted_markdown(
            &ws.get_by_id(&id).unwrap().unwrap().markdown
        ));
        assert!(
            !String::from_utf8_lossy(&all_bytes(&root)).contains("fixture-late-ordinary-secret")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
