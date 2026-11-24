---
name: tie-mcp-connect
description: "Choose Tie access: backend MCP HTTP when a backend is bound and serving it, otherwise the local tie CLI. Use when connecting Tie, when tie_* tools are missing, when the user binds or unbinds a backend, or when asked to change how the agent reaches the workspace. Do not start a local HTTP server. Do not configure command node or server.js."
---

# Tie 接入：后台 MCP HTTP，否则本机 CLI

Agent 看不到 Tie 客户端界面。HTTP 只出现在已绑定的后台上。没绑后台时没有本机端口，直接用 `tie` 可执行文件。

## 两条路

| 优先级 | 何时用 | 怎么接 |
|--------|--------|--------|
| 1. 后台 MCP HTTP | 用户给了后台根地址，且 `GET {后台}/health` 里 `mcp.running` 为 true、`mcp.url` 非空 | 客户端写这个 `mcp.url`（形如 `http://主机:8787/mcp`） |
| 2. 本机 MCP | 没有后台，或健康检查没有在跑的 MCP | `command` 为 `tie` 可执行文件，`args` 为 `["mcp"]`，环境变量 `TIE_WORKSPACE` 为工作区。不要写 `url`，不要在本机监听端口 |

本机没有单独的 HTTP 端口。`tie mcp` 从标准输入输出说 MCP，客户端拉起它之后就有 `tie_*` 工具。

## 怎么判断

1. 用户或上一次提示词里有后台根地址：请求 `GET {后台}/health`。
2. `mcp.running === true` 且 `mcp.url` 有值 → 选后台，配置就写这个 `mcp.url`。
3. 否则选本机 MCP。`command` 用 `tie` / `tie.exe` 的绝对路径，`args` 为 `["mcp"]`。找不到就按 Skill `tie-upgrade-cli` 构建。
4. 已经连着后台 MCP 且 `tie_doctor` 为 `ok: true`：保持当前连接。只有用户明确要换，或健康检查不再给出 `mcp.url`，才改回本机 CLI。

## 后台 HTTP 怎么写

只保留一个名为 `tie` 的 MCP 项，`url` 用 `mcp.url`。

- Cursor：`~/.cursor/mcp.json` 的 `mcpServers.tie.url`
- Codex：`~/.codex/config.toml` 的 `[mcp_servers.tie]`，`url = "..."`，不要写 `command`
- Claude Code：`~/.claude.json` 的 `mcpServers.tie`，`type` 为 `http`，带 `url`

`TIE_ACTOR` 用客户端名（Cursor / Codex / Claude Code），不要写「我」。设了 `TIE_MCP_TOKEN` 时，请求头加 `Authorization: Bearer <token>`。token 不要写进知识库页面。写完告诉用户新开一个对话。

## 本机 MCP 怎么写

`command` 用 `tie` / `tie.exe` 的绝对路径，`args` 只有 `mcp`。不要写 `url`，不要写 `node`。

- Cursor：`mcpServers.tie.command` + `args: ["mcp"]`，`env.TIE_WORKSPACE`
- Codex：`[mcp_servers.tie]` 的 `command` 和 `args = ["mcp"]`，`[mcp_servers.tie.env]` 里写 `TIE_WORKSPACE`
- Claude Code：`type` 为 `stdio`，同样的 `command` 和 `args`

写完让用户新开对话，先 `tie_doctor`。不要手改 `pages` 里的 frontmatter。

## 切换

1. 后台健康检查开始给出 `mcp.url`：改成只写这个 `url`，去掉 `command`。然后让用户新开对话。
2. 健康检查不再给出地址，或用户解开后台：改回 `tie mcp`。当前对话里的工具要到新对话才换。
3. 不要在本机再启动一套 HTTP，也不要留 `command: node` 的 `server.js`。
