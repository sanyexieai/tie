use std::path::{Path, PathBuf};

pub fn markdown_path(root: &Path, page_id: &str) -> PathBuf {
    root.join("pages").join(format!("{page_id}.md"))
}

pub fn revision_dir(root: &Path, page_id: &str) -> PathBuf {
    root.join(".tie").join("history").join(page_id)
}

pub fn page_asset_dir(root: &Path, page_id: &str) -> PathBuf {
    root.join(".tie").join("assets").join(page_id)
}

pub fn sanitize_asset_name(file_name: &str) -> Result<String, String> {
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

pub fn settings_file(data_dir: &Path) -> PathBuf {
    data_dir.join("workspace.json")
}

pub fn default_workspace_root(data_dir: &Path) -> PathBuf {
    data_dir.join("workspace")
}
