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

已有本地工作区时保留 `tie mcp` 桥接。绑定服务器后先检查 `/health`，正常时走 HTTP；异常时通过 `tie_connection` 取得用户确认才可降级本地。无本地应用的原生 HTTP Agent 可用用户主动提供的 MCP token 直接连接。按 Skill `tie-mcp-connect`，不要在本机再起 HTTP，也不要配 `command: node`。

### B. Tie 桌面端

1. 打开 Tie → **存储设置 → Agent 知识库**
2. 选客户端 → **接入所选客户端**，配置写入本机 `tie mcp`；有绑定时由 CLI 读取后台地址与同源登录会话
3. 没绑后台：仍用同一本机 MCP 入口提供 `tie_doctor` 等工具，同时替换旧的 node 启动项
4. **新开** Agent 会话后再试

### C. 命令行

```bash
npm run mcp:setup -- --workspace /绝对路径/工作区 --url http://后台主机:8787/mcp
```

脚本始终配置本机 `tie mcp`。`--url` 保存为 `TIE_MCP_URL`；不传时，CLI 从本地工作区绑定读取后台地址。无绑定的工作区直接使用本地。没有本地会话时，按 `tie-mcp-connect` 由用户提供 MCP token，优先使用私有 `TIE_MCP_TOKEN_FILE`。

## 兼容问题交给 AI（不要手改）

| 现象 | 做法 |
|------|------|
| MCP 起不来 / CLI 未找到 | 按上面构建并设置 CLI 路径；本机 Agent 配置 `command` + `args: ["mcp"]` |
| `format check` 报缺 frontmatter / 缺 id | `tie_get` 读到内容后用 `tie_write`（带 `pageId` 或 `matchTitle`）重写；**禁止**手写 YAML frontmatter |
| 旧 `file:///` 链接 | 用 `tie_write` 改成 `tie://file/…` 或 `tie://path/…`；或跟 Skill `tie-update` 看 migration |
| 客户端仍用 node 启动 server.js | 重跑桌面「接入」或 `mcp:setup`，替换成 Rust `tie mcp`；指定的 `--url` 由桥接使用 |
| HTTP 故障 / 授权不可用 | 查看 `tie_connection` 状态；先取得用户明确同意，再确认当前故障期的本地降级，不能自动回退 |
| 本地 MCP 写入后未同步 | 查看结果的 `sync.state`；`pending` 时保存已成功但仍需排查登录与后台连接，不能声称已同步 |

## 验收

1. `tie_doctor` → `ok: true`；服务器正常时还须 `transport: "http"`
2. `tie_get`、`tie_list_recent` 有返回，再用 `tie_doctor` 确认通道未变化
3. 经用户要求测试写入时，`tie_write` 建测试笔记；本地保存需核对 `sync.state`，HTTP 写入需在后台工作区核对，勿用手写 frontmatter 测试

## 注意

- 密钥、token **不要**写入知识库页面
- 本 Skill 不替代 `tie-memory`；日常记忆仍用 `tie_write` + tags
- 发布版用户优先用桌面「接入」；本仓库贡献者用 `cargo build -p tie-cli`
