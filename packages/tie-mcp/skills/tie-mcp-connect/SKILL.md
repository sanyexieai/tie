---
name: tie-mcp-connect
description: "Connect Tie through the local tie mcp bridge or a remote HTTP MCP endpoint. Check server health, prefer the local login session or request the user's MCP token, require explicit user confirmation before local fallback, and verify the actual transport. Do not start a local HTTP server or use node/server.js."
---

# Tie 接入：检查服务器，再选择授权和通道

已有本地工作区的 Cursor、Codex、Claude Code 保留本机 `tie mcp`（stdio）入口。绑定服务器时，数据请求先检查 `/health`，服务器正常就走 HTTP；纯本地工作区直接在本地处理。

没有 Tie 应用或本地工作区的 Agent，可以用原生 HTTP MCP 直接连接服务器 `/mcp`，也可只安装 CLI 做远程桥接。本机不另起 HTTP 端口，不使用 `node` 或 `server.js`。

## 授权

1. 有本地登录会话：CLI 从应用数据目录的 `backend-session.json` 读取同一服务器的会话，从工作区 `.tie/sync.json` 读取绑定。401 时可刷新一次，不要求用户重复提供 token。
2. 没有本地登录会话或没有应用：请用户主动提供该服务器签发的 MCP token。它已绑定用户和工作区，纯远程访问无需本地工作区。

token 只能通过客户端的凭据管理、临时环境变量或私有 token 文件提供。禁止写入知识库页面、提交仓库或打印到日志。MCP token 不替代本地工作区同步所需的账号登录。

## 本机桥接配置

只保留一个名为 `tie` 的 MCP 项。`command` 用 CLI 的绝对路径，`args` 为 `["mcp"]`。有本地工作区时设置 `TIE_WORKSPACE`；`TIE_ACTOR` 用客户端名（Cursor / Codex / Claude Code），不要写「我」。

- Cursor：`~/.cursor/mcp.json` 的 `mcpServers.tie.command`、`args` 和 `env`
- Codex：`~/.codex/config.toml` 的 `[mcp_servers.tie]` 和 `[mcp_servers.tie.env]`
- Claude Code：`~/.claude.json` 的 `mcpServers.tie`，`type: "stdio"`

远程桥接可设置 `TIE_MCP_URL`（服务器根地址或 `/mcp`）和 `TIE_MCP_TOKEN_FILE`（仅当前用户可读的 token 文件路径）；也支持临时 `TIE_MCP_TOKEN`。纯远程 token 模式无需 `TIE_WORKSPACE`。不要将现有桌面桥接配置改成仅 HTTP。

## 原生 HTTP Agent

无本地应用时，使用 `/health` 返回的 `mcp.url`，在客户端凭据管理中设置 `Authorization: Bearer <MCP token>`。不要在共享配置、示例或知识库中填入真实 token。后台不提供本机文件登记、打开提示和导入导出能力。

## HTTP 异常时

HTTP 故障、未开启或授权不可用时，不得自行改用本地，也不能通过换配置绕过确认。

1. 调用 `tie_connection`，参数 `action: "status"`，取得故障原因和 `confirmationId`。
2. 向用户说明故障，以及将改用哪份本地副本；等待用户明确同意。用户没有回答不算同意。
3. 用户同意后才调用 `tie_connection`，参数 `action: "confirm_local"`、步骤 1 的 `confirmationId`、`confirmed: true`。

许可仅在当前故障期有效；HTTP 成功后撤销。纯本地工作区不需要降级确认。没有本地副本的远程 Agent 只能报告故障，不能伪造本地降级。

宿主文件登记、打开提示、导入和导出始终在本机执行，不把本机路径发送给服务器。存在服务器绑定时，它们也先检查服务器；HTTP 异常时同样受上述确认流程约束，不得绕过门控直接执行本机操作。

## 验证与写入

配置完成后新开 Agent 会话：

1. 调用 `tie_doctor`，检查 `ok: true`；服务器正常时还须看到 `transport: "http"`。
2. 调用 `tie_get`、`tie_list_recent` 验证真实读取，再调用 `tie_doctor` 确认通道没有变化。工具列表成功不证明 HTTP 已连通。
3. 本机 `tie_write`、`tie_import`、`tie_file_ingest` 成功后会尽力同步一次。检查结果中的 `sync.state`：`synced` 表示本轮成功，`pending` 表示本地已保存但同步未完成，`skipped` 表示没有绑定服务器。不要把落盘成功说成已同步。后台 HTTP 子进程不会反向同步。

找不到 CLI 时按 Skill `tie-upgrade-cli` 构建。页面内容只用 `tie_*` 工具读写，不手改 frontmatter。
