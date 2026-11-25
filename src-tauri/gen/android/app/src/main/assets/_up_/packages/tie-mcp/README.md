# @tie/mcp

这里只放 Agent Skill 模板。MCP 工具由 Rust `tie mcp` 实现。后台打开 HTTP MCP 时，也是把请求交给 `tie-cli mcp`，不在这个目录里跑 Node。页面格式见 [`docs/page-format.md`](../../docs/page-format.md)。

Agent 怎么接：

- 绑定了后台，且管理员已在「服务」里打开 MCP：客户端配置写 `/health` 里的 `mcp.url`，并使用用户自己的 MCP 令牌。后台把请求交给 Rust `tie-cli mcp`
- 没绑后台：不写 URL，也不要用 `node` 启动 `server.js`。直接调用本机 `tie`

桌面端负责按协议渲染并打开本地链接。Skill 在设置里接入时同步到工作区 `.agents/skills/`，以及 `~/.agents/skills`、`~/.claude/skills`、`~/.cursor/skills`。

## 能力

| Tool | 作用 |
|------|------|
| `tie_doctor` | 诊断 CLI / 工作区 / `format check`；升级时先调 |
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

Skill `tie-mcp-connect`：后台 `/health` 给出 `mcp.url` 时用该 HTTP 地址；没绑后台时直接调用本机 `tie` CLI，不在本机再起 HTTP。

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
3. 后台 MCP HTTP 在跑时，「接入所选客户端」写入该地址
4. 没绑后台时，同一按钮去掉旧的 node 启动项，并同步 Skill。Agent 改用本机 `tie`

**Skill 真相源：** `<工作区>/.agents/skills/<name>/SKILL.md`

## 命令行

```bash
npm run mcp:setup -- --workspace /绝对路径/你的工作区 --url http://后台主机:8787/mcp
npm run mcp:setup -- --workspace /绝对路径/你的工作区 --dry-run
```

`--url` 写入所选客户端的 `tie` 项。不传 `--url` 时删除这项里旧的 `command` / `args`，并打印 `tie --workspace ...`。

## 手动配置（仅后台 HTTP）

Codex `~/.codex/config.toml`：

```toml
[mcp_servers.tie]
url = "http://后台主机:8787/mcp"
enabled = true
```

Cursor `~/.cursor/mcp.json` 的 `mcpServers.tie` 只写 `url`。Claude Code 的 `mcpServers.tie` 写 `type: "http"` 和 `url`。不要写 `command` 或 `args`。

没绑后台时不要写这段。用：

```bash
tie --workspace /绝对路径/你的工作区 recent
```

## 安全约定

- 只读写指定工作区下的 `pages/`、`.tie/history/`、`.tie/files/`
- 禁止 Agent 手写裸 frontmatter；一律走 `tie_write`
- 区外文件走 `tie_file_ingest`（link → `tie://file/…`，copy → `tie://path/…`）；区内路径写 `tie://path/…`；不要用 `file:///`
- 不要把密钥、token 写入知识库页面
