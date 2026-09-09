//! Cross-platform filesystem path helpers.
//!
//! Windows `canonicalize` often yields `\\?\C:\...` / `\\?\UNC\...`. Those forms
//! break equality checks, Skill scan dedupe, shell open, and external tool configs
//! (Node / Codex / Cursor). Normalize once here; call sites should not reimplement.

use std::path::{Path, PathBuf};

/// Strip Windows extended-length / verbatim prefixes when present.
///
/// Always inspects the string form so unit tests and cross-OS configs work even
/// when not compiling for Windows.
pub fn strip_extended_length_prefix(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    let text = raw.as_ref();

    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix(r"UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    if let Some(rest) = text.strip_prefix("//?/") {
        if let Some(unc) = rest.strip_prefix("UNC/") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }

    path.to_path_buf()
}

/// Canonicalize when possible, then strip Windows extended prefixes.
pub fn canonicalize(path: &Path) -> PathBuf {
    let resolved = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf());
    strip_extended_length_prefix(&resolved)
}

/// Path suitable for shell / OS opener (no `\\?\` prefix).
pub fn for_shell_open(path: &Path) -> PathBuf {
    strip_extended_length_prefix(path)
}

/// Path suitable for writing into external configs (MCP, env vars, TOML/JSON).
pub fn for_external_config(path: &Path) -> PathBuf {
    strip_extended_length_prefix(path)
}

/// Stable absolute-ish display / persistence string (canonical + stripped).
pub fn display_string(path: &Path) -> String {
    canonicalize(path).to_string_lossy().into_owned()
}

fn compare_key(path: &Path) -> String {
    let stripped = strip_extended_length_prefix(path);
    let text = stripped.to_string_lossy();
    #[cfg(windows)]
    {
        // Windows paths are case-insensitive; also normalize separators for compare.
        text.replace('/', "\\").to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        text.into_owned()
    }
}

/// True when two paths refer to the same location after normalize.
pub fn paths_equal(left: &Path, right: &Path) -> bool {
    compare_key(&canonicalize(left)) == compare_key(&canonicalize(right))
}

/// True when `path` is `root` or a descendant (after normalize).
pub fn is_under_root(path: &Path, root: &Path) -> bool {
    let path_key = compare_key(&canonicalize(path));
    let root_key = compare_key(&canonicalize(root));
    if path_key == root_key {
        return true;
    }
    #[cfg(windows)]
    {
        let prefix = if root_key.ends_with('\\') {
            root_key
        } else {
            format!("{root_key}\\")
        };
        path_key.starts_with(&prefix)
    }
    #[cfg(not(windows))]
    {
        let prefix = if root_key.ends_with('/') {
            root_key
        } else {
            format!("{root_key}/")
        };
        path_key.starts_with(&prefix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn strips_windows_drive_prefix() {
        let path = PathBuf::from(r"\\?\C:\Users\sanye\.cursor\skills-cursor\automate\SKILL.md");
        assert_eq!(
            strip_extended_length_prefix(&path),
            PathBuf::from(r"C:\Users\sanye\.cursor\skills-cursor\automate\SKILL.md")
        );
    }

    #[test]
    fn strips_windows_unc_prefix() {
        let path = PathBuf::from(r"\\?\UNC\server\share\skills");
        assert_eq!(
            strip_extended_length_prefix(&path),
            PathBuf::from(r"\\server\share\skills")
        );
    }

    #[test]
    fn strips_forward_slash_verbatim_prefix() {
        let path = PathBuf::from("//?/C:/Users/sanye/skill.md");
        assert_eq!(
            strip_extended_length_prefix(&path),
            PathBuf::from("C:/Users/sanye/skill.md")
        );
    }

    #[test]
    fn leaves_posix_paths_alone() {
        let path = PathBuf::from("/home/sanye/.cursor/skills/automate/SKILL.md");
        assert_eq!(strip_extended_length_prefix(&path), path);
    }
}
