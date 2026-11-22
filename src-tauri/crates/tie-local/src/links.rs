//! Link helpers for Tie Markdown bodies (`tie://…`, `[[title]]`).

const FILE_URL_PREFIX: &str = "tie://file/";
const PATH_URL_PREFIX: &str = "tie://path/";

pub fn is_storage_source_id(value: &str) -> bool {
    let id = value.trim();
    if id.is_empty() {
        return false;
    }
    if id == "source-demo-local" {
        return true;
    }
    if id.len() == 26
        && (id.starts_with("src_local_") || id.starts_with("src_smb_"))
        && id[10..].chars().all(|c| c.is_ascii_hexdigit())
    {
        return true;
    }
    if id.starts_with("s3:") && id.len() > 3 {
        return true;
    }
    if id.starts_with("backend:") || id.starts_with("backend-s3:") {
        return true;
    }
    false
}

fn decode_segment(segment: &str) -> String {
    percent_decode(segment)
}

fn encode_segment(segment: &str) -> String {
    percent_encode(segment)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn split_href_segments(raw: &str) -> Vec<String> {
    raw.split('/')
        .filter(|part| !part.is_empty())
        .map(decode_segment)
        .collect()
}

fn rest_after_prefix<'a>(href: &'a str, prefix: &str) -> &'a str {
    href.get(prefix.len()..)
        .unwrap_or("")
        .split(['?', '#'])
        .next()
        .unwrap_or("")
}

fn is_file_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn build_file_url(file_id: &str, source_id: &str) -> String {
    let id = file_id.trim();
    let source = source_id.trim();
    if source.is_empty() {
        format!("{FILE_URL_PREFIX}{id}")
    } else {
        format!(
            "{}{}/{}",
            FILE_URL_PREFIX,
            encode_segment(source),
            encode_segment(id)
        )
    }
}

pub fn build_path_url(relative_path: &str, source_id: &str) -> String {
    let encoded = relative_path
        .split('/')
        .filter(|part| !part.is_empty())
        .map(encode_segment)
        .collect::<Vec<_>>()
        .join("/");
    let source = source_id.trim();
    if source.is_empty() {
        format!("{PATH_URL_PREFIX}{encoded}")
    } else {
        format!(
            "{}{}/{}",
            PATH_URL_PREFIX,
            encode_segment(source),
            encoded
        )
    }
}

struct FileUrlRef {
    file_id: String,
    source_id: Option<String>,
}

struct PathUrlRef {
    relative_path: String,
    source_id: Option<String>,
}

fn parse_file_url(href: &str) -> Option<FileUrlRef> {
    if !href.starts_with(FILE_URL_PREFIX) {
        return None;
    }
    let parts = split_href_segments(rest_after_prefix(href, FILE_URL_PREFIX));
    if parts.len() >= 2 && is_storage_source_id(&parts[0]) {
        if !is_file_id(&parts[1]) {
            return None;
        }
        return Some(FileUrlRef {
            source_id: Some(parts[0].clone()),
            file_id: parts[1].clone(),
        });
    }
    if parts.len() == 1 && is_file_id(&parts[0]) {
        return Some(FileUrlRef {
            file_id: parts[0].clone(),
            source_id: None,
        });
    }
    None
}

fn parse_path_url(href: &str) -> Option<PathUrlRef> {
    if !href.starts_with(PATH_URL_PREFIX) {
        return None;
    }
    let parts = split_href_segments(rest_after_prefix(href, PATH_URL_PREFIX));
    if parts.is_empty() {
        return None;
    }
    if parts.len() >= 2 && is_storage_source_id(&parts[0]) {
        return Some(PathUrlRef {
            source_id: Some(parts[0].clone()),
            relative_path: parts[1..].join("/"),
        });
    }
    Some(PathUrlRef {
        relative_path: parts.join("/"),
        source_id: None,
    })
}

fn is_href_boundary(c: char) -> bool {
    c.is_whitespace() || matches!(c, ')' | ']' | '>' | '\'' | '"')
}

/// Rewrite legacy `tie://file/{id}` / `tie://path/{rel}` to include `source_id`.
pub fn rewrite_legacy_workspace_hrefs(markdown: &str, page_source_id: &str) -> String {
    let source = page_source_id.trim();
    if source.is_empty() || !is_storage_source_id(source) {
        return markdown.to_owned();
    }

    let bytes = markdown.as_bytes();
    let mut out = String::with_capacity(markdown.len() + 16);
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"tie://file/") || bytes[i..].starts_with(b"tie://path/") {
            let start = i;
            i += if bytes[i..].starts_with(b"tie://file/") {
                FILE_URL_PREFIX.len()
            } else {
                PATH_URL_PREFIX.len()
            };
            while i < bytes.len() && !is_href_boundary(bytes[i] as char) {
                i += 1;
            }
            let href = &markdown[start..i];
            let rewritten = if let Some(file) = parse_file_url(href) {
                if file.source_id.is_some() {
                    href.to_owned()
                } else {
                    build_file_url(&file.file_id, source)
                }
            } else if let Some(relative) = parse_path_url(href) {
                if relative.source_id.is_some() {
                    href.to_owned()
                } else {
                    build_path_url(&relative.relative_path, source)
                }
            } else {
                href.to_owned()
            };
            out.push_str(&rewritten);
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_legacy_file_and_path() {
        let source = "src_local_0123456789abcdef";
        let input = "see tie://file/file_abc and tie://path/docs/a.pdf";
        let out = rewrite_legacy_workspace_hrefs(input, source);
        assert!(out.contains(&format!("tie://file/{source}/file_abc")));
        assert!(out.contains(&format!("tie://path/{source}/docs/a.pdf")));
    }
}
