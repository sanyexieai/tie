# @tie/mcp

这里只放 Agent Skill 模板。MCP 工具由 Rust `tie mcp` 实现。后台打开 HTTP MCP 时，也是把请求交给 `tie-cli mcp`，不在这个目录里跑 Node。页面格式见 [`docs/page-format.md`](../../docs/page-format.md)。

Agent 怎么接：

- 有本地工作区：客户端配置保留本机 `tie mcp`。绑定服务器后先检查健康状态，正常时通过 HTTP 读写；HTTP 异常需用户明确确认才可降级本地。
- 没有 Tie 应用或本地登录会话：用户提供 MCP token，可用原生 HTTP Agent 连接 `/health` 里的 `mcp.url`，或给 CLI 桥接配置远程地址和私有 token 文件，无需本地工作区。
- 纯本地工作区：直接使用本机 `tie mcp`，无需服务器或降级确认。不要用 `node` 启动 `server.js`，也不要在本机另起 HTTP 服务。

桌面端负责按协议渲染并打开本地链接。Skill 在设置里接入时同步到工作区 `.agents/skills/`，以及 `~/.agents/skills`、`~/.claude/skills`、`~/.cursor/skills`。

## 能力

| Tool | 作用 |
|------|------|
| `tie_doctor` | 诊断 CLI / 工作区 / `format check`；升级时先调 |
| `tie_connection` | 查看 HTTP 故障状态；仅在用户明确同意后确认当前故障期的本地降级 |
| `tie_search` | 关键词 / 标签搜索 |
| `tie_get` | 按 id 或精确标题读取全文 |
| `tie_write` | 安全写入（自动 frontmatter；更新前写入 `.tie/history`） |
| `tie_related` | 出链 / 入链 / 子页 / 同标签 |
| `tie_list_recent` | 最近更新 |
| `tie_file_ingest` | 登记外部**文件或目录**：`link` 绝对登记 / `copy` 导入相对副本；返回 `url` |
| `tie_file_get` | 按 fileId 读文件资源元数据 |
| `tie_file_list` | 列出已登记文件资源 |
| `tie_file_open_hint` | 返回可打开路径（不替用户打开） |
| `tie_migration_status` | 版本化迁移 stamp + 是否需 Agent 收尾（**不是**每次更新都要调） |

记忆类型 `kind`：`decision` | `bug` | `preference` | `note`（自动加 `memory` 等标签）。

Skill `tie-update`（`packages/tie-mcp/skills/tie-update`）只跟目录里标了 `agentFollowUp` 的 migration；发布说明未点名时不要因「刚更新」启用。

Skill `tie-mcp-connect`：说明登录会话与 MCP token 两种授权、HTTP 健康检查、用户确认降级和本地写入后同步。已有桌面接入保留本机 CLI 桥接；无应用的远程 Agent 允许直接使用 HTTP。

本机 `tie_write`、`tie_import`、`tie_file_ingest` 成功后调用与 `tie sync` 相同的同步核心，尽力对齐一次。结果中的 `sync.state` 为 `synced`、`pending` 或 `skipped`，分别表示本轮成功、仍待同步、未绑定服务器。保存成功不等于同步完成；失败时保留本地数据。后台 HTTP 的 CLI 子进程不反向同步。

## 正文链接协议

| 用途 | 写法 | 桌面样式 |
|------|------|----------|
| 页面 | `[[标题]]` / `tie://page/{id}` | 普通链接 |
| 已登记文件/目录 | `tie://file/{sourceId}/{id}` 或旧写法 `tie://file/{id}` | 登记；缺失会标出 |
| 工作区内相对路径 | `tie://path/{sourceId}/{相对路径}` | 相对（含 copy 导入） |
| 页面图片附件 | `tie://asset/{pageId}/{文件名}` | 图片（相对路径 `.tie/assets/{pageId}/{文件名}` 的显示别名） |

文件资源落在工作区 `.tie/files/`（与页面图片附件 `.tie/assets/` 分开）。**区外**登记写 `tie://file/…`；**区内**（含 copy）写 `tie://path/…`。不要写 `file:///`。新写入的 `url` 会带上 `sourceId`：优先环境变量 `TIE_SOURCE_ID` / `TIE_STORAGE_SOURCE_ID`，否则从工作区页面的 `storage_source_id` 推断。

## 桌面端设置

Tie 桌面端 → **存储设置** → **Agent 知识库**：

1. 选择本地或 SMB 工作区
2. 勾选 Codex / Cursor / Claude Code
3. 「接入所选客户端」写入本机 `tie mcp`；后台地址和登录会话由 CLI 读取
4. 没绑后台时仍用相同 CLI 入口读写本地工作区，并同步 Skill、替换旧的 node 启动项

**Skill 真相源：** `<工作区>/.agents/skills/<name>/SKILL.md`

## 命令行

```bash
npm run mcp:setup -- --workspace /绝对路径/你的工作区 --url http://后台主机:8787/mcp
npm run mcp:setup -- --workspace /绝对路径/你的工作区 --dry-run
```

此脚本写入本机 `tie mcp`；`--url` 保存为 `TIE_MCP_URL`，不会丢弃远程地址或把已有桌面配置替换成仅 HTTP。授权由本地登录会话或用户提供的 MCP token 完成。

## 手动配置

已有本地工作区的 Agent 配置保留本机 `tie mcp`。绑定服务器后，实际数据请求先检查健康状态，正常时走 HTTP；异常时使用 `tie_connection` 查看故障，取得用户明确同意后再确认本地降级。HTTP 恢复后撤销降级许可。

Cursor `~/.cursor/mcp.json` 的 `mcpServers.tie` 写 `command` 和 `args: ["mcp"]`，环境变量 `TIE_WORKSPACE` 指向工作区。Codex、Claude Code 同样写这个命令。

没有本地应用或工作区时，可在支持 HTTP MCP 的 Agent 中填写服务器 `/mcp` 地址，并通过客户端的凭据管理提供用户的 MCP token（Bearer 授权）。已有登录会话优先使用同源会话，401 时可刷新一次；没有会话时向用户索取 MCP token，不尝试无授权访问。

也可以只安装 CLI，再通过私有 token 文件桥接远程 MCP：

```bash
TIE_MCP_URL="https://后台主机:8787/mcp" \
TIE_MCP_TOKEN_FILE="/绝对路径/私有mcp-token" \
/绝对路径/tie mcp
```

`TIE_MCP_URL` 也接受服务器根地址；此模式无需 `TIE_WORKSPACE`。`TIE_MCP_TOKEN` 可作为临时环境变量传入。不要把 token 明文写入共享配置、命令记录、知识库或仓库；优先使用凭据管理或仅当前用户可读的 token 文件。

直接查本地页面可以用：

```bash
tie --workspace /绝对路径/你的工作区 recent
```

## 安全约定

- 只读写指定工作区下的 `pages/`、`.tie/history/`、`.tie/files/`
- 禁止 Agent 手写裸 frontmatter；一律走 `tie_write`
- 区外文件走 `tie_file_ingest`（link → `tie://file/…`，copy → `tie://path/…`）；区内路径写 `tie://path/…`；不要用 `file:///`
- 不要把密钥、token 写入知识库页面
