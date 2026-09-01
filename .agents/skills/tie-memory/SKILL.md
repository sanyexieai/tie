---
name: tie-memory
description: "Tie app development notes. End-user Agent Skills are managed inside Tie under Agent Skills — not this repo path."
---

# 开发本仓库时

用户侧 Skill 在 Tie「Agent Skills」里接入与编辑。

改 MCP / 接入逻辑时参考 `packages/tie-mcp` 与 `src-tauri/src/skills.rs`。

`tauri:dev` 无故整窗重启 → 先读并执行 Skill `tauri-dev-restart-loop`（清 Cursor checkpoint），不要当成业务 bug。
