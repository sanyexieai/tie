//! Password protected Markdown, compatible with the client's Web Crypto v1 envelope.
use crate::{changes::ReviewFile, is_encrypted_markdown, ENCRYPTED_MARKDOWN_PREFIX};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::{
    aead, pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use std::num::NonZeroU32;

const SUFFIX: &str = "-----END TIE ENCRYPTED MARKDOWN-----";
const ITERATIONS: u32 = 600_000;
const ADDITIONAL_DATA: &[u8] = b"tie:encrypted-markdown:v1";

#[derive(Deserialize, Serialize)]
struct Envelope {
    version: u8,
    algorithm: String,
    kdf: String,
    iterations: u32,
    salt: String,
    iv: String,
    ciphertext: String,
}

pub fn encrypt_markdown(markdown: &str, password: &str) -> Result<String, String> {
    require_password(password)?;
    let random = SystemRandom::new();
    let mut salt = [0; 16];
    let mut iv = [0; 12];
    random
        .fill(&mut salt)
        .and_then(|_| random.fill(&mut iv))
        .map_err(|_| "无法生成文档加密随机数")?;
    let key = derive_key(password, &salt)?;
    let mut ciphertext = markdown.as_bytes().to_vec();
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(iv),
        aead::Aad::from(ADDITIONAL_DATA),
        &mut ciphertext,
    )
    .map_err(|_| "无法加密文档")?;
    let envelope = Envelope {
        version: 1,
        algorithm: "AES-256-GCM".into(),
        kdf: "PBKDF2-SHA256".into(),
        iterations: ITERATIONS,
        salt: STANDARD.encode(salt),
        iv: STANDARD.encode(iv),
        ciphertext: STANDARD.encode(ciphertext),
    };
    Ok(format!(
        "{ENCRYPTED_MARKDOWN_PREFIX}\n{}\n{SUFFIX}\n",
        serde_json::to_string(&envelope).map_err(|e| e.to_string())?
    ))
}

pub fn decrypt_markdown(markdown: &str, password: &str) -> Result<String, String> {
    require_password(password)?;
    let (salt, iv, mut ciphertext) = parse_envelope(markdown)?;
    let key = derive_key(password, &salt)?;
    let plaintext = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(iv),
            aead::Aad::from(ADDITIONAL_DATA),
            &mut ciphertext,
        )
        .map_err(|_| "无法解密文档，请检查密码或文件是否完整")?;
    String::from_utf8(plaintext.to_vec())
        .map_err(|_| "无法解密文档，请检查密码或文件是否完整".into())
}

pub fn protect_reviews(mut file: ReviewFile, password: &str) -> Result<ReviewFile, String> {
    for entry in &mut file.entries {
        if entry.kind == "opinion" || !entry.quote.is_empty() || !entry.body.is_empty() {
            if !entry.quote.is_empty() || !is_encrypted_markdown(&entry.body) {
                entry.body = encrypt_markdown(
                    &serde_json::json!({ "version": 1, "quote": entry.quote, "body": entry.body })
                        .to_string(),
                    password,
                )?;
            }
            entry.quote.clear();
        }
        if !entry.markdown.is_empty() && !is_encrypted_markdown(&entry.markdown) {
            entry.markdown = encrypt_markdown(&entry.markdown, password)?;
        }
        if let Some(note) = &mut entry.resolution_note {
            if !note.is_empty() && !is_encrypted_markdown(note) {
                *note = encrypt_markdown(note, password)?;
            }
        }
    }
    Ok(file)
}

/// Callers verify the current page password before reading legacy unencrypted fields.
pub fn reveal_reviews(mut file: ReviewFile, password: &str) -> Result<ReviewFile, String> {
    for entry in &mut file.entries {
        if is_encrypted_markdown(&entry.body) {
            let payload: serde_json::Value =
                serde_json::from_str(&decrypt_markdown(&entry.body, password)?)
                    .map_err(|_| "加密意见格式无效")?;
            if payload["version"] != 1 {
                return Err("加密意见格式无效".into());
            }
            let quote = payload["quote"].as_str().ok_or("加密意见格式无效")?;
            if entry.quote.is_empty() {
                entry.quote = quote.into();
            }
            entry.body = payload["body"].as_str().ok_or("加密意见格式无效")?.into();
        }
        if is_encrypted_markdown(&entry.quote) {
            entry.quote = decrypt_markdown(&entry.quote, password)?;
        }
        if is_encrypted_markdown(&entry.markdown) {
            entry.markdown = decrypt_markdown(&entry.markdown, password)?;
        }
        if let Some(note) = &mut entry.resolution_note {
            if is_encrypted_markdown(note) {
                *note = decrypt_markdown(note, password)?;
            }
        }
    }
    Ok(file)
}

fn require_password(password: &str) -> Result<(), String> {
    if password.is_empty() {
        Err("请输入加密密码".into())
    } else {
        Ok(())
    }
}

fn derive_key(password: &str, salt: &[u8]) -> Result<aead::LessSafeKey, String> {
    let mut derived = [0; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(ITERATIONS).unwrap(),
        salt,
        password.as_bytes(),
        &mut derived,
    );
    let key =
        aead::UnboundKey::new(&aead::AES_256_GCM, &derived).map_err(|_| "无法派生文档加密密钥")?;
    derived.fill(0);
    Ok(aead::LessSafeKey::new(key))
}

fn parse_envelope(markdown: &str) -> Result<(Vec<u8>, [u8; 12], Vec<u8>), String> {
    let invalid = || "加密文档格式无效或版本不受支持".to_owned();
    let normalized = markdown
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.trim_end().split('\n').collect();
    if lines.len() != 3 || lines[0] != ENCRYPTED_MARKDOWN_PREFIX || lines[2] != SUFFIX {
        return Err(invalid());
    }
    let envelope: Envelope = serde_json::from_str(lines[1]).map_err(|_| invalid())?;
    if envelope.version != 1
        || envelope.algorithm != "AES-256-GCM"
        || envelope.kdf != "PBKDF2-SHA256"
        || envelope.iterations != ITERATIONS
    {
        return Err(invalid());
    }
    let salt = STANDARD.decode(envelope.salt).map_err(|_| invalid())?;
    let iv: [u8; 12] = STANDARD
        .decode(envelope.iv)
        .map_err(|_| invalid())?
        .try_into()
        .map_err(|_| invalid())?;
    let ciphertext = STANDARD
        .decode(envelope.ciphertext)
        .map_err(|_| invalid())?;
    if salt.len() != 16 || ciphertext.len() < 16 {
        return Err(invalid());
    }
    Ok((salt, iv, ciphertext))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_crypto_roundtrip_tamper_and_invalid_parameters() {
        let text = "# 私密文档\n\nUnicode 内容\n";
        let encrypted = encrypt_markdown(text, "fixture-only-password").unwrap();
        assert!(!encrypted.contains("Unicode"));
        assert_eq!(
            decrypt_markdown(&encrypted, "fixture-only-password").unwrap(),
            text
        );
        assert_eq!(
            decrypt_markdown(
                &format!("\u{feff}{}", encrypted.replace('\n', "\r\n")),
                "fixture-only-password"
            )
            .unwrap(),
            text
        );
        assert!(decrypt_markdown(&encrypted, "wrong")
            .unwrap_err()
            .contains("无法解密"));
        assert!(decrypt_markdown(
            &encrypted.replace("600000", "600001"),
            "fixture-only-password"
        )
        .unwrap_err()
        .contains("格式"));
    }

    #[test]
    fn decrypts_a_real_web_crypto_envelope() {
        // Generated by Web Crypto, with fixed salt/IV only in this interoperability fixture.
        let json = r#"{"version":1,"algorithm":"AES-256-GCM","kdf":"PBKDF2-SHA256","iterations":600000,"salt":"AAECAwQFBgcICQoLDA0ODw==","iv":"EBESExQVFhcYGRob","ciphertext":"U3NnhBNy4dBk8Te+ytHxnNl+5qOhYgO/QKxork5fhXOyVJ39QAE5a6nwa0P+zcLyi2rJhg=="}"#;
        let markdown = format!("{ENCRYPTED_MARKDOWN_PREFIX}\n{json}\n{SUFFIX}\n");
        assert_eq!(
            decrypt_markdown(&markdown, "fixture-webcrypto-密码").unwrap(),
            "# 客户端\n\nfixture-from-webcrypto\n"
        );
    }

    #[test]
    fn recovers_mixed_legacy_reviews_after_the_caller_has_verified_the_page() {
        let password = "fixture-legacy-review-password";
        let mut protected = protect_reviews(
            ReviewFile {
                entries: vec![crate::changes::ReviewEntry {
                    id: "protected".into(),
                    kind: "opinion".into(),
                    quote: "original quote".into(),
                    body: "protected body".into(),
                    ..Default::default()
                }],
            },
            password,
        )
        .unwrap();
        protected.entries[0].quote = "legacy external quote".into();
        protected.entries.push(crate::changes::ReviewEntry {
            id: "legacy".into(),
            kind: "opinion".into(),
            quote: "legacy quote".into(),
            body: "legacy body".into(),
            resolution_note: Some("legacy note".into()),
            markdown: "legacy version".into(),
            ..Default::default()
        });
        let revealed = reveal_reviews(protected, password).unwrap();
        assert_eq!(revealed.entries[0].quote, "legacy external quote");
        assert_eq!(revealed.entries[0].body, "protected body");
        assert_eq!(revealed.entries[1].quote, "legacy quote");
        assert_eq!(revealed.entries[1].body, "legacy body");
        assert_eq!(
            revealed.entries[1].resolution_note.as_deref(),
            Some("legacy note")
        );
        assert_eq!(revealed.entries[1].markdown, "legacy version");
    }
}
