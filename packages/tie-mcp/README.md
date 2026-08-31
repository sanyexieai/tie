# @tie/mcp

本地优先的 Tie MCP Server：让 Codex（或其他 MCP 客户端）读写 **同一份** 工作区 `pages/*.md`，**不依赖** Tie Backend。

不影响桌面端：本包独立，不改 `src/` / `src-tauri/` 运行时逻辑。

## 能力

| Tool | 作用 |
|------|------|
| `tie_search` | 关键词 / 标签搜索 |
| `tie_get` | 按 id 或精确标题读取全文 |
| `tie_write` | 安全写入（自动 frontmatter；更新前写入 `.tie/history`） |
| `tie_related` | 出链 / 入链 / 子页 / 同标签 |
| `tie_list_recent` | 最近更新 |

记忆类型 `kind`：`decision` | `bug` | `preference` | `note`（自动加 `memory` 等标签）。

## 准备

```bash
# 在仓库根目录
npm install --prefix packages/tie-mcp
npm run test:mcp
```

工作区路径需指向含 `pages/` 的目录（桌面端「本地目录」存储源，或应用数据里的 workspace）。

## 桌面端设置（推荐）

Tie 桌面端 → **存储设置** → **Codex / Agent 知识库**：

1. 选择本地或 SMB 工作区（默认选中当前默认存储源）
2. 在 **Agent Skills** 里查看 / 编辑 / 新建 Skill（文件在工作区 `.agents/skills/`）
3. 点击「接入 Codex」（会把工作区 Skill 同步给 Codex）
4. 新开 Codex 会话即可使用 `tie_*` tools

本机需已安装 Node.js。

**Skill 真相源：** `<工作区>/.agents/skills/<name>/SKILL.md`（由 Tie 管理；接入时同步到 `~/.agents/skills` 供跨项目使用）

## Codex 一键接入（命令行）

```bash
# 在仓库根目录；workspace 需含 pages/
npm run mcp:setup -- --workspace /绝对路径/你的工作区
```

脚本会：

1. `npm install --prefix packages/tie-mcp`
2. 备份并写入 `~/.codex/config.toml` 的 `[mcp_servers.tie]`
3. 若工作区尚无 Skill，写入默认 `tie-memory` 到 `<workspace>/.agents/skills/`，并同步到 `~/.agents/skills`
4. 若 PATH 里有 `codex`，再尝试 `codex mcp add`（没有也不影响）

预览不改文件：

```bash
npm run mcp:setup -- --workspace /path/to/workspace --dry-run
```

## Codex 手动配置

`~/.codex/config.toml`：

```toml
[mcp_servers.tie]
command = "node"
args = ["/绝对路径/tie/packages/tie-mcp/src/server.js"]

[mcp_servers.tie.env]
TIE_WORKSPACE = "/绝对路径/你的工作区"
# 可选：写入时默认 storage_source_id
# TIE_STORAGE_SOURCE_ID = "src_xxxx"
```

或：

```bash
codex mcp add tie --env TIE_WORKSPACE=/绝对路径/你的工作区 -- node /绝对路径/tie/packages/tie-mcp/src/server.js
```

## 手动冒烟

```bash
TIE_WORKSPACE=/path/to/workspace npm run mcp
# stdin 等待 MCP JSON-RPC；日志在 stderr
```

## 安全约定

- 只读写指定工作区下的 `pages/` 与 `.tie/history/`
- 禁止 Agent 手写裸 frontmatter；一律走 `tie_write`
- 不要把密钥、token 写入知识库页面
