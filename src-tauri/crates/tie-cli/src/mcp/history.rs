use serde_json::{json, Value};
use tie_local::LocalWorkspace;

pub(super) fn diff(
    ws: &LocalWorkspace,
    key: &str,
    revision_id: &str,
    compare_to: Option<&str>,
) -> Result<Value, String> {
    let before = ws.get_revision(key, revision_id)?;
    let current = ws
        .get_by_id(&before.id)?
        .ok_or_else(|| format!("页面不存在：{key}"))?;
    let target_id = compare_to.unwrap_or("current");
    let after = if target_id == "current" {
        current.clone()
    } else {
        ws.get_revision(&current.id, target_id)?
    };
    let before_value = json!(before);
    let after_value = json!(after);
    let metadata_changes = ["title", "icon", "parentId", "sortKey", "tags", "deletedAt"]
        .into_iter()
        .filter(|field| before_value[field] != after_value[field])
        .map(|field| json!({ "field": field, "before": before_value[field], "after": after_value[field] }))
        .collect::<Vec<_>>();
    Ok(json!({
        "pageId": current.id,
        "fromRevisionId": revision_id,
        "toRevisionId": target_id,
        "currentUpdatedAt": current.updated_at,
        "changed": before.markdown != after.markdown || !metadata_changes.is_empty(),
        "metadataChanges": metadata_changes,
        "diff": markdown_diff(&before.markdown, &after.markdown, revision_id, target_id)
    }))
}

fn markdown_diff(before: &str, after: &str, from: &str, to: &str) -> String {
    if before == after {
        return String::new();
    }
    let old = before.split_inclusive('\n').collect::<Vec<_>>();
    let new = after.split_inclusive('\n').collect::<Vec<_>>();
    let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let old_middle = &old[prefix..old.len() - suffix];
    let new_middle = &new[prefix..new.len() - suffix];
    let start = prefix.saturating_sub(3);
    let old_end = old.len() - suffix + suffix.min(3);
    let new_end = new.len() - suffix + suffix.min(3);
    let old_count = old_end - start;
    let new_count = new_end - start;
    let mut out = format!(
        "--- {from}\n+++ {to}\n@@ -{},{} +{},{} @@\n",
        if old_count == 0 { start } else { start + 1 },
        old_count,
        if new_count == 0 { start } else { start + 1 },
        new_count
    );
    for line in &old[start..prefix] {
        push_line(&mut out, ' ', line);
    }
    // Use the editor's bounded LCS approach; large documents retain linear memory usage.
    if old_middle.len().saturating_mul(new_middle.len()) > 120_000 {
        for line in old_middle {
            push_line(&mut out, '-', line);
        }
        for line in new_middle {
            push_line(&mut out, '+', line);
        }
    } else {
        let columns = new_middle.len() + 1;
        let mut lengths = vec![0usize; (old_middle.len() + 1) * columns];
        for i in (0..old_middle.len()).rev() {
            for j in (0..new_middle.len()).rev() {
                lengths[i * columns + j] = if old_middle[i] == new_middle[j] {
                    lengths[(i + 1) * columns + j + 1] + 1
                } else {
                    lengths[(i + 1) * columns + j].max(lengths[i * columns + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < old_middle.len() || j < new_middle.len() {
            if i < old_middle.len() && j < new_middle.len() && old_middle[i] == new_middle[j] {
                push_line(&mut out, ' ', old_middle[i]);
                i += 1;
                j += 1;
            } else if j == new_middle.len()
                || (i < old_middle.len()
                    && lengths[(i + 1) * columns + j] >= lengths[i * columns + j + 1])
            {
                push_line(&mut out, '-', old_middle[i]);
                i += 1;
            } else {
                push_line(&mut out, '+', new_middle[j]);
                j += 1;
            }
        }
    }
    for line in &old[old.len() - suffix..old_end] {
        push_line(&mut out, ' ', line);
    }
    out
}

fn push_line(out: &mut String, prefix: char, line: &str) {
    out.push(prefix);
    out.push_str(line);
    if !line.ends_with('\n') {
        out.push_str("\n\\ No newline at end of file\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diffs_edits_and_keeps_unchanged_middle_lines() {
        let result = markdown_diff(
            "# 文档\n旧段\n保留\n尾部\n",
            "# 文档\n新段\n保留\n追加\n尾部\n",
            "old",
            "current",
        );
        assert!(result.starts_with("--- old\n+++ current\n@@ -1,4 +1,5 @@\n"));
        assert!(result.contains("-旧段\n+新段\n 保留\n+追加\n"));
    }

    #[test]
    fn diffs_empty_and_newline_only_changes() {
        assert_eq!(markdown_diff("", "", "a", "b"), "");
        assert_eq!(
            markdown_diff("", "新行\n", "a", "b"),
            "--- a\n+++ b\n@@ -0,0 +1,1 @@\n+新行\n"
        );
        assert_eq!(
            markdown_diff("行", "行\n", "a", "b"),
            "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-行\n\\ No newline at end of file\n+行\n"
        );
        assert!(markdown_diff("行\n", "", "a", "b").contains("@@ -1,1 +0,0 @@\n-行\n"));
    }

    #[test]
    fn large_rewrites_keep_common_context() {
        let before = format!("共同\n{}结尾\n", "旧\n".repeat(400));
        let after = format!("共同\n{}结尾\n", "新\n".repeat(400));
        let result = markdown_diff(&before, &after, "a", "b");
        assert!(result.contains("@@ -1,402 +1,402 @@\n 共同\n"));
        assert_eq!(result.lines().filter(|line| *line == "-旧").count(), 400);
        assert_eq!(result.lines().filter(|line| *line == "+新").count(), 400);
        assert!(result.ends_with(" 结尾\n"));
    }
}
