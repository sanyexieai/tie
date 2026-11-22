# Tie 仓库指引（Codex）

- 桌面端 / 本地优先知识库；可选 MCP：`packages/tie-mcp`
- **无 UI 本地读写**：Rust CLI `tie`（`src-tauri/crates/tie-cli`，`npm run tie -- …`）；页面格式见 `docs/page-format.md`；核心 API 在 `tie-local`
- **MCP**：只经 Rust `tie` CLI（无 JS 回退）。缺 CLI 时进程退出；用 Skill `tie-upgrade-cli` + tool `tie_doctor` 让 Agent 升级/修兼容。`mcp:setup` / 桌面接入会构建或写入 `TIE_CLI`
- **格式校验**：`tie format check` / MCP `tie_doctor`
- **文件登记**：桌面与 CLI/MCP 共用 `tie-local::FileRegistry`；Android `content://` 仍走 SAF
- **Android 精简版**：本地目录（应用内 / 自选文件夹）、S3、自定义后台；存储分层见 `src-tauri/crates/`（`tie-common` 类型、`tie-local` 本地读写、`tie-s3` S3、`tie-storage` 聚合）；Tauri 薄壳在 `local/`、`s3/`、`mobile.rs`；桌面专用在 `desktop/`；无 `keyring`、MCP/Skills
- **Skill 由 Tie 管理**：写在所选工作区的 `.agents/skills/`，设置页可编辑；接入 Agent（Codex / Cursor / Claude Code）时同步到对应目录（`~/.agents/skills` 等）
- 沉淀记忆用 `tie_*` MCP tools；不要把手写 frontmatter 的 Markdown 直接塞进工作区
- 密钥、token 禁止写入知识库页面
- **`tauri:dev` 无故反复重启**：多半是 Cursor checkpoint 回写 `src-tauri`（尤其 `lib.rs`）。先跑 `python3 scripts/clear-tie-checkpoints.py`，不要先改业务代码。详见 Skill `tauri-dev-restart-loop`（`.agents/skills/` / `.cursor/skills/`）
- **`tauri:android:build` 产物**：`app-universal-release-unsigned.apk` 需签名后才能 `adb install`；`npm run android:debug -- --install-only` 会用 debug.keystore 自动签名
