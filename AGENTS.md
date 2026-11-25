# Tie 仓库指引（Codex）

- 桌面端 / 本地优先知识库。Agent 的本机 MCP 是 `tie mcp`。后台 HTTP MCP 也调用这个 Rust CLI。`packages/tie-mcp` 只留 Skill 模板
- **连接状态**：只有「本地」和「本地 + 服务器」。本地是工作区，可绑定多个；服务器只绑定一台，绑定后云同步。S3 是服务器存储能力，不是用户可见源。同步见 `docs/sync.md`（用户只感知保存）
- **无 UI 本地读写**：Rust CLI `tie`（`src-tauri/crates/tie-cli`，`npm run tie -- …`）；页面格式见 `docs/page-format.md`；核心 API 在 `tie-local`。工作区入口为文本 **`.tie` 解决方案**；整树携带为 **`.tiez`**（`tie pack` / `tie unpack`）
- **MCP**：页面读写只经 Rust `tie` CLI（无 JS 回退）。已有本地工作区的 Agent 保留 `tie mcp`（stdio），绑定服务器后先检查健康状态，正常走 HTTP；异常需用户明确确认后通过 `tie_connection` 许可当前故障期的本地降级，HTTP 成功即撤销。优先用同源登录会话，无会话时由用户提供 MCP token；无应用的原生 HTTP Agent 可直接连接 `/mcp`。本地 MCP 写入后尽力同步一次，检查 `sync.state`，不混淆落盘与同步完成。不要在本机再起 HTTP，也不要用 `node` 启动 `server.js`。缺 CLI 时用 Skill `tie-upgrade-cli` + `tie_doctor`
- **格式校验**：`tie format check` / MCP `tie_doctor`
- **文件登记**：桌面与 CLI/MCP 共用 `tie-local::FileRegistry`；Android `content://` 仍走 SAF
- **Git**：安装包不自带；桌面按需下载到应用数据目录或使用系统 `git`（`TIE_GIT` 可覆盖）。逻辑在 `desktop/git_sync.rs`。同步进程 `tie sync` 对接的是后台 API，不是 Git remote
- **后台 MCP HTTP**：在管理后台「服务」里打开，并填写 `tie-cli` 路径。用户在 `/me/` 签发自己的令牌。客户端从 `/health` 读取 `mcp.url`
- **导出闭包**：`tie export` / `tie import`；MCP `tie_export` / `tie_import`
- **同步语义**：`docs/sync.md`（用户只感知保存）
- **Android 精简版**：本地目录（应用内 / 自选文件夹）、自定义后台（含后台托管 S3）；直连 S3 源废弃中。存储分层见 `src-tauri/crates/`（`tie-common`、`tie-local`、`tie-s3`、`tie-storage`）；Tauri 薄壳在 `local/`、`s3/`、`mobile.rs`；桌面专用在 `desktop/`；无 `keyring`、MCP/Skills
- **Skill 由 Tie 管理**：写在所选工作区的 `.agents/skills/`，设置页可编辑；接入 Agent（Codex / Cursor / Claude Code）时同步到对应目录（`~/.agents/skills` 等）
- 沉淀记忆用 `tie_*` MCP tools；不要把手写 frontmatter 的 Markdown 直接塞进工作区
- 密钥、token 禁止写入知识库页面
- **`tauri:dev` 无故反复重启**：多半是 Cursor checkpoint 回写 `src-tauri`（尤其 `lib.rs`）。先跑 `python3 scripts/clear-tie-checkpoints.py`，不要先改业务代码。详见 Skill `tauri-dev-restart-loop`（`.agents/skills/` / `.cursor/skills/`）
- **`tauri:android:build` 产物**：`app-universal-release-unsigned.apk` 需签名后才能 `adb install`；`npm run android:debug -- --install-only` 会用 debug.keystore 自动签名
