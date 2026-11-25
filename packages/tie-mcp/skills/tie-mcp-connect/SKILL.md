---
name: tie-mcp-connect
description: "Connect Tie for a local agent by launching tie mcp. That process tries backend MCP HTTP first and uses the local workspace when HTTP is down. Use when connecting Tie, when tie_* tools are missing, when the user binds or unbinds a backend, or when asked to change how the agent reaches the workspace. Do not start a local HTTP server. Do not configure command node or server.js. Do not replace the local command with a url-only entry."
---

# Tie 接入：本机 tie mcp，先试后台 HTTP

Agent 看不到 Tie 客户端界面。Cursor、Codex、Claude Code 都只拉起本机 `tie mcp`。这个进程每次请求先用登录会话访问后台 `/mcp`；连不上、未开启或登录不可用时，再读写 `TIE_WORKSPACE` 里的本地工作区。两种能力都在同一个进程里，不要改成只留 HTTP 或只留本地。

本机没有单独的 HTTP 端口。不要在本机再听一个端口，也不要用 `node` 启动 `server.js`。

## 怎么写

只保留一个名为 `tie` 的 MCP 项。`command` 用 `tie` / `tie.exe` 的绝对路径，`args` 只有 `mcp`。环境变量 `TIE_WORKSPACE` 为工作区目录。`TIE_ACTOR` 用客户端名（Cursor / Codex / Claude Code），不要写「我」。

- Cursor：`~/.cursor/mcp.json` 的 `mcpServers.tie.command` + `args: ["mcp"]`
- Codex：`~/.codex/config.toml` 的 `[mcp_servers.tie]`，`command` 和 `args = ["mcp"]`，工作区写在 `[mcp_servers.tie.env]`
- Claude Code：`~/.claude.json` 的 `mcpServers.tie`，`type` 为 `stdio`，同样的 `command` 和 `args`

不要写 `url`。不要把登录令牌或 MCP 令牌写进配置文件，也不要写进知识库页面。登录会话在应用数据目录的 `backend-session.json`，工作区地址在 `.tie/sync.json`，由 `tie mcp` 自己读。

找不到 CLI 时按 Skill `tie-upgrade-cli` 构建。

## 写完之后

告诉用户新开一个对话。新对话里先 `tie_doctor`。`ok` 为 true 之后再用 `tie_search`、`tie_get`、`tie_write`。不要手改 pages 里的 frontmatter。

`tie_doctor` 的 `transport` 为 `http` 时，这次请求走了后台；为 `local` 时走的是本地工作区。后台恢复后，下一次请求会再试 HTTP。
