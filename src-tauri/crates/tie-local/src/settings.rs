use crate::paths::settings_file;
use tie_common::{StorageSource, WorkspaceSettings};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};

pub fn load(data_dir: &Path) -> Result<WorkspaceSettings, String> {
    let settings_path = settings_file(data_dir);
    match fs::read_to_string(settings_path) {
        Ok(content) => serde_json::from_str(&content).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(WorkspaceSettings {
            name: String::new(),
            path: String::new(),
            kind: String::new(),
            sources: Vec::new(),
            s3_providers: Vec::new(),
        }),
        Err(error) => Err(error.to_string()),
    }
}

pub fn save(data_dir: &Path, settings: &WorkspaceSettings) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let content = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(settings_file(data_dir), content).map_err(|error| error.to_string())
}

fn source_id(path: &Path, kind: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    kind.hash(&mut hasher);
    format!("src_{kind}_{:016x}", hasher.finish())
}

pub fn source_from_path(path: PathBuf, kind: String) -> StorageSource {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("我的知识库")
        .to_owned();
    StorageSource {
        id: source_id(&path, &kind),
        name,
        kind,
        path: path.display().to_string(),
        available: true,
    }
}

pub fn workspace_sources(
    settings: &WorkspaceSettings,
    default_root: &Path,
) -> (Vec<StorageSource>, bool) {
    if !settings.sources.is_empty() {
        return (settings.sources.clone(), false);
    }
    if !settings.path.is_empty() {
        let kind = if settings.kind == "smb" {
            "smb"
        } else {
            "local"
        }
        .to_owned();
        return (
            vec![source_from_path(PathBuf::from(&settings.path), kind)],
            false,
        );
    }
    (
        vec![source_from_path(default_root.to_path_buf(), "local".to_owned())],
        true,
    )
}
