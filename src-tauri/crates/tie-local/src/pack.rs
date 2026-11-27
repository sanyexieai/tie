//! `.tiez` — compressed workspace tree (same layout as on disk).
//!
//! Packs `pages/`, `.tie/`, and root `*.tie` solution files. Not a second
//! content model — unpack then open with the normal engine.

use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackReport {
    pub archive: String,
    pub workspace: String,
    pub files: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpackReport {
    pub archive: String,
    pub out: String,
    pub files: usize,
    pub solution: Option<String>,
}

fn should_skip(rel: &Path) -> bool {
    let mut components = rel.components();
    let Some(first) = components.next() else {
        return true;
    };
    let first = first.as_os_str().to_string_lossy();
    matches!(
        first.as_ref(),
        ".git" | "node_modules" | "target" | ".DS_Store"
    ) || first.ends_with(".tiez") || rel.starts_with(".tie/page-locks")
        || [".tie/sync-index.json", ".tie/sync-index.json.tmp", ".tie/sync-cursor.json.tmp", ".tie/backend-sync.lock"].iter().any(|name| rel == Path::new(name))
}

fn collect_pack_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    fn walk(dir: &Path, root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_path_buf();
            if should_skip(&rel) {
                continue;
            }
            if path.is_dir() {
                walk(&path, root, out)?;
            } else if path.is_file() {
                out.push(rel);
            }
        }
        Ok(())
    }

    let pages = root.join("pages");
    if !pages.is_dir() {
        return Err(format!("工作区无效：缺少 {}", pages.display()));
    }
    walk(&pages, root, &mut out)?;

    let tie_dir = root.join(".tie");
    if tie_dir.is_dir() {
        walk(&tie_dir, root, &mut out)?;
    }

    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.is_file() {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext == "tie" {
                if let Ok(rel) = path.strip_prefix(root) {
                    out.push(rel.to_path_buf());
                }
            }
        }
    }

    out.sort();
    out.dedup();
    Ok(out)
}

fn zip_name(rel: &Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Pack a workspace directory into a `.tiez` archive.
pub fn pack_tiez(workspace_root: &Path, archive: &Path) -> Result<PackReport, String> {
    let root = workspace_root
        .canonicalize()
        .map_err(|e| format!("无法打开工作区：{e}"))?;
    if archive.exists() {
        return Err(format!("目标已存在：{}", archive.display()));
    }
    if let Some(parent) = archive.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    let files = collect_pack_files(&root)?;
    let file = File::create(archive).map_err(|e| format!("无法创建归档：{e}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut total_bytes = 0u64;

    for rel in &files {
        let abs = root.join(rel);
        let mut buf = Vec::new();
        File::open(&abs)
            .and_then(|mut f| f.read_to_end(&mut buf))
            .map_err(|e| format!("读取 {} 失败：{e}", abs.display()))?;
        total_bytes += buf.len() as u64;
        zip.start_file(zip_name(rel), options)
            .map_err(|e| format!("写入 zip 失败：{e}"))?;
        zip.write_all(&buf)
            .map_err(|e| format!("写入 zip 失败：{e}"))?;
    }
    zip.finish().map_err(|e| format!("完成 zip 失败：{e}"))?;

    Ok(PackReport {
        archive: archive.display().to_string(),
        workspace: root.display().to_string(),
        files: files.len(),
        bytes: total_bytes,
    })
}

/// Unpack a `.tiez` into `out` (must not exist or be empty).
pub fn unpack_tiez(archive: &Path, out: &Path) -> Result<UnpackReport, String> {
    if !archive.is_file() {
        return Err(format!("归档不存在：{}", archive.display()));
    }
    if out.exists() {
        if out.is_dir() {
            let mut entries = fs::read_dir(out).map_err(|e| e.to_string())?;
            if entries.next().is_some() {
                return Err(format!("输出目录非空：{}", out.display()));
            }
        } else {
            return Err(format!("输出路径已存在：{}", out.display()));
        }
    } else {
        fs::create_dir_all(out).map_err(|e| e.to_string())?;
    }

    let file = File::open(archive).map_err(|e| format!("无法打开归档：{e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("无效的 .tiez：{e}"))?;
    let mut count = 0usize;
    let mut solution: Option<String> = None;

    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("读取归档条目失败：{e}"))?;
        let name = entry.name().replace('\\', "/");
        let relative = Path::new(&name);
        if name.is_empty()
            || name.contains(':')
            || relative.components().any(|part| {
                matches!(part, Component::ParentDir | Component::RootDir | Component::Prefix(_))
            })
        {
            return Err(format!("归档含非法路径：{name}"));
        }
        let dest = out.join(relative);
        if name.ends_with('/') {
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut outfile = File::create(&dest).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
        count += 1;
        if name.rsplit('/').next().is_some_and(|base| {
            Path::new(base)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("tie"))
                .unwrap_or(false)
        }) && !name.contains('/')
        {
            solution = Some(dest.display().to_string());
        }
    }

    if !out.join("pages").is_dir() {
        return Err("解压结果不是有效工作区（缺少 pages/）".to_owned());
    }

    Ok(UnpackReport {
        archive: archive.display().to_string(),
        out: out.display().to_string(),
        files: count,
        solution,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{LocalWorkspace, WritePageInput};
    use crate::solution::{write_solution, TieSolution};
    use std::env;

    #[test]
    fn unpack_rejects_paths_outside_output() {
        let dir = env::temp_dir().join(format!("tie-unpack-paths-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let outside = dir.join("outside.md");
        fs::write(&outside, "keep").unwrap();
        let names = [
            "../outside.md".to_owned(),
            "pages/../outside.md".to_owned(),
            outside.display().to_string(),
            "C:\\outside.md".to_owned(),
            "\\\\server\\share\\outside.md".to_owned(),
        ];
        for (index, name) in names.iter().enumerate() {
            let archive = dir.join(format!("invalid-{index}.tiez"));
            let mut zip = ZipWriter::new(File::create(&archive).unwrap());
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(b"replace").unwrap();
            zip.finish().unwrap();
            let out = dir.join(format!("out-{index}"));
            let error = unpack_tiez(&archive, &out).unwrap_err();
            assert!(error.contains("归档含非法路径"), "{name}: {error}");
            assert_eq!(fs::read_to_string(&outside).unwrap(), "keep");
            assert!(fs::read_dir(&out).unwrap().next().is_none());
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn pack_unpack_roundtrip() {
        let dir = env::temp_dir().join(format!("tie-pack-{}", std::process::id()));
        let out = env::temp_dir().join(format!("tie-unpack-{}", std::process::id()));
        let archive = env::temp_dir().join(format!("tie-pack-{}.tiez", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&out);
        let _ = fs::remove_file(&archive);

        let ws = LocalWorkspace::init(&dir, "src_local_packtest012345").unwrap();
        write_solution(
            &dir.join("demo.tie"),
            &TieSolution::new("demo", "src_local_packtest012345"),
        )
        .unwrap();
        ws.write_page(WritePageInput {
            title: Some("Packed".into()),
            markdown: Some("body".into()),
            ..Default::default()
        })
        .unwrap();

        fs::create_dir_all(dir.join(".tie/page-locks")).unwrap();
        fs::write(dir.join(".tie/page-locks/active.lock"), "").unwrap();
        fs::write(dir.join(".tie/sync-index.json"), "{\"deviceLocalCache\":true}").unwrap();
        fs::write(dir.join(".tie/sync-index.json.tmp"), "pending local cache").unwrap();
        fs::write(dir.join(".tie/backend-sync.lock"), "").unwrap();
        fs::write(dir.join(".tie/sync-cursor.json.tmp"), "pending cursor").unwrap();
        let report = pack_tiez(&dir, &archive).unwrap();
        assert!(report.files >= 2);
        let unpacked = unpack_tiez(&archive, &out).unwrap();
        assert!(out.join("pages").is_dir());
        assert!(!out.join(".tie/page-locks").exists());
        assert!(!out.join(".tie/sync-index.json").exists());
        assert!(!out.join(".tie/sync-index.json.tmp").exists());
        assert!(!out.join(".tie/backend-sync.lock").exists());
        assert!(!out.join(".tie/sync-cursor.json.tmp").exists());
        assert!(unpacked.solution.is_some());

        let ws2 = LocalWorkspace::open(&out, Some("src_local_packtest012345")).unwrap();
        let hits = ws2.search("Packed", None, 5, false).unwrap();
        assert!(!hits.is_empty());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&out);
        let _ = fs::remove_file(&archive);
    }
}
