# Tie 仓库指引（Codex）

- 桌面端 / 本地优先知识库；可选 MCP：`packages/tie-mcp`
- **Android 精简版**：仅 S3 / 自定义后台；Rust 见 `common/` + `s3/` + `mobile.rs`；无 `desktop/`、`keyring`、MCP/Skills
- **Skill 由 Tie 管理**：写在所选工作区的 `.agents/skills/`，设置页可编辑；接入 Agent（Codex / Cursor / Claude Code）时同步到对应目录（`~/.agents/skills` 等）
- 沉淀记忆用 `tie_*` MCP tools；不要把手写 frontmatter 的 Markdown 直接塞进工作区
- 密钥、token 禁止写入知识库页面
- **`tauri:dev` 无故反复重启**：多半是 Cursor checkpoint 回写 `src-tauri`（尤其 `lib.rs`）。先跑 `python3 scripts/clear-tie-checkpoints.py`，不要先改业务代码。详见 Skill `tauri-dev-restart-loop`（`.agents/skills/` / `.cursor/skills/`）
- **`tauri:dev` 端口占用**：Vite 默认 `1420`；若报 already in use，结束残留 `node .../vite` 后再启动
