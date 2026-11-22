---
name: tie-upgrade-cli
description: "Upgrade Tie MCP to the Rust `tie` CLI backend and fix workspace/format compatibility. Use when MCP fails to start, logs say tie CLI 未找到, tie_doctor reports problems, Agent 知识库接入后 tools 不可用, or after Tie upgrades that require CLI."
---

# Tie MCP → CLI 升级与兼容修复

Tie **不再**提供 MCP 内置 JS 页面回退。页面与文件登记必须经 Rust CLI（`tie`）。本 Skill 让 Agent 自行完成升级与格式兼容，**不要**让用户手改 frontmatter。

## 目标状态

- 环境变量：`TIE_WORKSPACE` = 含 `pages/` 的工作区根
- 环境变量：`TIE_CLI` = `tie` 可执行文件绝对路径（或 PATH 能找到 `tie`）
- `tie_doctor` 返回 `ok: true`
- 页面读写只用 `tie_*` MCP tools / `tie` CLI，不手写 `---\nid:` frontmatter

## 诊断（先做）

1. 调 MCP `tie_doctor`（若 MCP 都起不来，在仓库根用终端）：

```bash
# 仓库开发态
cargo build -p tie-cli --manifest-path src-tauri/Cargo.toml
export TIE_CLI="$PWD/src-tauri/target/debug/tie"   # Windows: target\debug\tie.exe
export TIE_WORKSPACE="/绝对路径/工作区"             # 含 pages/
"$TIE_CLI" --workspace "$TIE_WORKSPACE" format check
```

2. 看 `format check` / `tie_doctor.formatCheck.errors`：列出坏文件与错误信息。

## 安装 / 接入 CLI

按环境选一条路径即可：

### A. 从本仓库构建（开发者）

```bash
cargo build -p tie-cli --release --manifest-path src-tauri/Cargo.toml
# 或
npm run tie:prepare
```

把 `TIE_CLI` 指到：

- `src-tauri/target/release/tie`（或 `.exe`）
- 或 `src-tauri/binaries/tie-<host-triple>`（`tie:prepare` 产物）

### B. Tie 桌面端

1. 打开 Tie → **存储设置 → Agent 知识库**
2. 选工作区与客户端 → **接入所选客户端**
3. 桌面会写入 MCP 配置里的 `TIE_CLI`（若已构建/打包 sidecar）
4. **新开** Agent 会话后再试 `tie_doctor`

### C. 命令行接入脚本

```bash
npm run mcp:setup -- --workspace /绝对路径/工作区
```

脚本若找到已构建的 `tie`，会写入 `TIE_CLI`。

## 兼容问题交给 AI（不要手改）

| 现象 | 做法 |
|------|------|
| MCP 起不来 / CLI 未找到 | 按上面构建并设置 `TIE_CLI`，更新 MCP env，重开会话 |
| `format check` 报缺 frontmatter / 缺 id | `tie_get` 读到内容后用 `tie_write`（带 `pageId` 或 `matchTitle`）重写；**禁止**手写 YAML frontmatter |
| 旧 `file:///` 链接 | 用 `tie_write` 改成 `tie://file/…` 或 `tie://path/…`；或跟 Skill `tie-update` 看 migration |
| 页面能读但 Agent 配置仍指向旧路径 | 备份后重跑桌面「接入」或 `mcp:setup` |
| 多源 / 云同步 | CLI 只负责**本地工作区**；S3/后台仍用 Tie 桌面，不要用 CLI 冒充同步 |

## 验收

1. `tie_doctor` → `ok: true`
2. `tie_list_recent` 有返回
3. `tie_write` 建一页测试笔记，桌面端刷新可见同一文件

## 注意

- 密钥、token **不要**写入知识库页面
- 本 Skill 不替代 `tie-memory`；日常记忆仍用 `tie_write` + tags
- 发布版用户优先用桌面「接入」；本仓库贡献者用 `cargo build -p tie-cli`
