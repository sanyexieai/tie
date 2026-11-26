use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub(crate) struct PendingOpenFiles(Mutex<Vec<String>>);

fn file_paths(arguments: &[String], cwd: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    for argument in arguments.iter().skip(1) {
        let path = if argument.starts_with("file://") {
            let Ok(url) = tauri::Url::parse(argument) else {
                continue;
            };
            let Ok(path) = url.to_file_path() else {
                continue;
            };
            path
        } else {
            let path = PathBuf::from(argument);
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        };
        if !path.extension().is_some_and(|ext| {
            ["md", "markdown", "tie", "tiez"]
                .iter()
                .any(|value| ext.eq_ignore_ascii_case(value))
        }) {
            continue;
        }
        let Ok(path) = path.canonicalize() else {
            continue;
        };
        if !path.is_file() {
            continue;
        }
        let path = tie_storage::fs_path::strip_extended_length_prefix(&path)
            .to_string_lossy()
            .into_owned();
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

pub(crate) fn enqueue(app: &tauri::AppHandle, arguments: &[String], cwd: &Path) {
    let paths = file_paths(arguments, cwd);
    if paths.is_empty() {
        return;
    }
    let pending = app.state::<PendingOpenFiles>();
    if let Ok(mut pending) = pending.0.lock() {
        for path in paths {
            if !pending.contains(&path) {
                pending.push(path);
            }
        }
    }
    // Keep the paths queued until the frontend has installed its listener and consumes them.
    let _ = app.emit("tie:open-files", ());
}

#[tauri::command]
pub(crate) fn consume_open_file_paths(
    pending: tauri::State<'_, PendingOpenFiles>,
) -> Result<Vec<String>, String> {
    let mut paths = pending.0.lock().map_err(|error| error.to_string())?;
    Ok(std::mem::take(&mut *paths))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_unicode_and_file_urls_without_importing_files() {
        let root =
            std::env::temp_dir().join(format!("tie-launch-{}", tie_storage::local::new_page_id()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("中文 空格.MD");
        std::fs::write(&file, "# Original\n").unwrap();
        let url = tauri::Url::from_file_path(&file).unwrap().to_string();
        let paths = file_paths(
            &[
                "tie".into(),
                "中文 空格.MD".into(),
                url,
                "--help".into(),
                "missing.md".into(),
            ],
            &root,
        );
        assert_eq!(paths, vec![file.to_string_lossy().into_owned()]);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Original\n");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
