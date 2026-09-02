use std::path::Path;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::PathBuf;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn markdown_path(root: &Path, page_id: &str) -> PathBuf {
    root.join("pages").join(format!("{page_id}.md"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn revision_dir(root: &Path, page_id: &str) -> PathBuf {
    root.join(".tie").join("history").join(page_id)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn page_asset_dir(root: &Path, page_id: &str) -> PathBuf {
    root.join(".tie").join("assets").join(page_id)
}

pub(crate) fn sanitize_asset_name(file_name: &str) -> Result<String, String> {
    let base = Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("附件名称无效")?;
    if base.is_empty()
        || base == "."
        || base == ".."
        || !base
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '.' || character == '-' || character == '_')
    {
        return Err("附件名称无效".to_owned());
    }
    Ok(base.to_owned())
}
