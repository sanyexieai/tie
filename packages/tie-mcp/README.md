# @tie/mcp

本地优先的 Tie MCP Server：让 Codex（或其他 MCP 客户端）读写 **同一份** 工作区 `pages/*.md` 与 `.tie/files/`，**不依赖** Tie Backend。

桌面端负责渲染 `tie://file/`（副本/外链不同样式）并用系统应用打开；登记与整理以 MCP/Skill 为主入口。

## 能力

| Tool | 作用 |
|------|------|
| `tie_search` | 关键词 / 标签搜索 |
| `tie_get` | 按 id 或精确标题读取全文 |
| `tie_write` | 安全写入（自动 frontmatter；更新前写入 `.tie/history`） |
| `tie_related` | 出链 / 入链 / 子页 / 同标签 |
| `tie_list_recent` | 最近更新 |
| `tie_file_ingest` | 登记外部文件：`copy` 导入副本 / `link` 外链；返回元数据与 `tie://file/{id}` |
| `tie_file_get` | 按 fileId 读文件资源元数据 |
| `tie_file_list` | 列出已登记文件资源 |
| `tie_file_open_hint` | 返回可打开路径（不替用户打开） |

记忆类型 `kind`：`decision` | `bug` | `preference` | `note`（自动加 `memory` 等标签）。

文件资源落在工作区 `.tie/files/`（与页面图片附件 `.tie/assets/` 分开）。正文链接统一用 `tie://file/{id}`；桌面端按 `mode` 区分副本/外链样式。

## 准备

```bash
# 在仓库根目录
npm install --prefix packages/tie-mcp
npm run test:mcp
```

工作区路径需指向含 `pages/` 的目录（桌面端「本地目录」存储源，或应用数据里的 workspace）。

## 桌面端设置（推荐）

Tie 桌面端 → **存储设置** → **Agent 知识库**：

1. 选择本地或 SMB 工作区（默认选中当前默认存储源）
2. 勾选要接入的客户端：Codex / Cursor / Claude Code
3. 在 **Agent Skills** 里查看 / 编辑 / 新建 Skill（文件在工作区 `.agents/skills/`）
4. 点击「接入所选客户端」（会写入对应 MCP 配置，并同步 Skill）
5. 新开客户端会话即可使用 `tie_*` tools

本机需已安装 Node.js。

**Skill 真相源：** `<工作区>/.agents/skills/<name>/SKILL.md`  
接入时同步到 `~/.agents/skills`，并按所选客户端同步到 `~/.claude/skills` / `~/.cursor/skills`。

## 一键接入（命令行）

```bash
# 默认接入 Codex + Cursor + Claude Code；workspace 需含 pages/
npm run mcp:setup -- --workspace /绝对路径/你的工作区

# 仅部分客户端
npm run mcp:setup -- --workspace /绝对路径/你的工作区 --clients cursor,claude
```

脚本会：

1. `npm install --prefix packages/tie-mcp`
2. 备份并写入所选客户端的 MCP 配置：
   - Codex → `~/.codex/config.toml` 的 `[mcp_servers.tie]`
   - Cursor → `~/.cursor/mcp.json` 的 `mcpServers.tie`
   - Claude Code → `~/.claude.json` 的 `mcpServers.tie`
3. 若工作区尚无 Skill，写入默认 `tie-memory`，并同步到对应 Skill 目录
4. 若选了 Codex 且 PATH 里有 `codex`，再尝试 `codex mcp add`（没有也不影响）

预览不改文件：

```bash
npm run mcp:setup -- --workspace /path/to/workspace --dry-run
```

## 手动配置

### Codex

`~/.codex/config.toml`：

```toml
[mcp_servers.tie]
command = "node"
args = ["/绝对路径/tie/packages/tie-mcp/src/server.js"]
default_tools_approval_mode = "approve"

[mcp_servers.tie.env]
TIE_WORKSPACE = "/绝对路径/你的工作区"
```

> 桌面发布包会把 `tie-mcp` 打进应用资源目录（`$RESOURCE/tie-mcp`）。接入时会复制到应用数据目录并 `npm install`；本机仍需有 Node.js。

或：

```bash
codex mcp add tie --env TIE_WORKSPACE=/绝对路径/你的工作区 -- node /绝对路径/tie/packages/tie-mcp/src/server.js
```

### Cursor

`~/.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "tie": {
      "command": "node",
      "args": ["/绝对路径/tie/packages/tie-mcp/src/server.js"],
      "env": {
        "TIE_WORKSPACE": "/绝对路径/你的工作区"
      }
    }
  }
}
```

### Claude Code

`~/.claude.json`（用户级，合并写入 `mcpServers`，保留其它字段）：

```json
{
  "mcpServers": {
    "tie": {
      "type": "stdio",
      "command": "node",
      "args": ["/绝对路径/tie/packages/tie-mcp/src/server.js"],
      "env": {
        "TIE_WORKSPACE": "/绝对路径/你的工作区"
      }
    }
  }
}
```

也可：`claude mcp add --scope user ...`。
## 手动冒烟

```bash
TIE_WORKSPACE=/path/to/workspace npm run mcp
# stdin 等待 MCP JSON-RPC；日志在 stderr
```

## 安全约定

- 只读写指定工作区下的 `pages/`、`.tie/history/`、`.tie/files/`
- 禁止 Agent 手写裸 frontmatter；一律走 `tie_write`
- 外部文件必须走 `tie_file_ingest`；不要把二进制塞进 Markdown
- 不要把密钥、token 写入知识库页面
