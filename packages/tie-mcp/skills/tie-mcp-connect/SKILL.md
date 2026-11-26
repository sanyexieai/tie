---
name: tie-mcp-connect
description: "Connect Tie through the local tie mcp bridge or a remote HTTP MCP endpoint. Check server health, prefer the local login session or request the user's MCP token, require explicit user confirmation before local fallback, and verify the actual transport. Do not start a local HTTP server or use node/server.js."
---

# Tie 接入：检查服务器，再选择授权和通道

已有本地工作区的 Cursor、Codex、Claude Code 默认保留本机 `tie mcp`（stdio）入口。绑定服务器时，数据请求先检查 `/health`，服务器正常就走 HTTP；纯本地工作区直接在本地处理。用户明确选择只通过 HTTP 访问服务器时，即使本机已有应用或工作区，也可改用原生 HTTP MCP，不要求保留本地入口。

原生 HTTP MCP 客户端只需服务器地址与用户 MCP token，无需本机 Tie、CLI 或工作区。需要 stdio 的客户端也可只安装 CLI 做远程桥接。本机不另起 HTTP 端口，不使用 `node` 或 `server.js`。

## 授权

1. 本机桥接有本地登录会话时：CLI 从应用数据目录的 `backend-session.json` 读取同一服务器的会话，从工作区 `.tie/sync.json` 读取绑定。401 时可刷新一次，不要求用户重复提供 token。
2. 原生 HTTP 客户端或本机桥接没有本地登录会话时：请用户主动提供该服务器签发的 MCP token。它已绑定用户和工作区，纯远程访问无需本地工作区。

token 只能通过客户端的凭据管理、临时环境变量或私有 token 文件提供。禁止写入知识库页面、提交仓库或打印到日志。MCP token 不替代本地工作区同步所需的账号登录。

## 本机桥接配置

只保留一个名为 `tie` 的 MCP 项。`command` 用 CLI 的绝对路径，`args` 为 `["mcp"]`。有本地工作区时设置 `TIE_WORKSPACE`；`TIE_ACTOR` 用客户端名（Cursor / Codex / Claude Code），不要写「我」。

- Cursor：`~/.cursor/mcp.json` 的 `mcpServers.tie.command`、`args` 和 `env`
- Codex：`~/.codex/config.toml` 的 `[mcp_servers.tie]` 和 `[mcp_servers.tie.env]`
- Claude Code：`~/.claude.json` 的 `mcpServers.tie`，`type: "stdio"`

远程桥接可设置 `TIE_MCP_URL`（服务器根地址或 `/mcp`）和 `TIE_MCP_TOKEN_FILE`（仅当前用户可读的 token 文件路径）；也支持临时 `TIE_MCP_TOKEN`。纯远程 token 模式无需 `TIE_WORKSPACE`。未经用户明确选择，不将现有桌面桥接配置改成仅 HTTP。

## 原生 HTTP Agent

用户选择 HTTP 直连时，先检查 `/health`，确认 `mcp.enabled`、`mcp.running`，使用返回的 `mcp.url`。在客户端凭据管理中设置 `Authorization: Bearer <MCP token>`；不配置本地 command、args 或工作区路径，不要求安装 CLI。不要在共享配置、示例或知识库中填入真实 token。后台不提供本机文件登记、打开提示和导入导出能力。

## HTTP 异常时

HTTP 故障、未开启或授权不可用时，不得自行改用本地，也不能通过换配置绕过确认。

原生 HTTP 客户端仅报告连接或授权故障，等待服务器恢复或用户提供有效 token；不安装本地工具，不切换本地，也不调用 `tie_connection`。该工具仅由本机桥接提供。

以下降级流程仅适用于已有本地副本的本机桥接：

1. 调用 `tie_connection`，参数 `action: "status"`，取得故障原因和 `confirmationId`。
2. 向用户说明故障，以及将改用哪份本地副本；等待用户明确同意。用户没有回答不算同意。
3. 用户同意后才调用 `tie_connection`，参数 `action: "confirm_local"`、步骤 1 的 `confirmationId`、`confirmed: true`。

许可仅在当前故障期有效；HTTP 成功后撤销。纯本地工作区不需要降级确认。没有本地副本的远程桥接只能报告故障，不能伪造本地降级。

宿主文件登记、打开提示、导入和导出始终在本机执行，不把本机路径发送给服务器。存在服务器绑定时，它们也先检查服务器；HTTP 异常时同样受上述确认流程约束，不得绕过门控直接执行本机操作。

## 验证与写入

配置完成后新开 Agent 会话：

1. 调用 `tie_doctor`，检查 `ok: true`；服务器正常时还须看到 `transport: "http"`。
2. 调用 `tie_get`、`tie_list_recent` 验证真实读取，再调用 `tie_doctor` 确认通道没有变化。工具列表成功不证明 HTTP 已连通。
3. 本机 `tie_write`、`tie_restore`、`tie_import`、`tie_file_ingest` 成功后会尽力同步一次。检查结果中的 `sync.state`：`synced` 表示本轮成功，`pending` 表示本地已保存但同步未完成，`skipped` 表示没有绑定服务器。不要把落盘或本地恢复成功说成已同步。后台 HTTP 子进程不会反向同步。

历史工具沿用已确认的数据通道：`tie_history({id_or_title, limit?})` 列出历史（每页最多保留 80 个快照），`tie_revision_get({id_or_title, revisionId})` 读取旧版，`tie_diff({id_or_title, revisionId, compareTo?})` 默认按旧版 → 当前页对比，`compareTo` 也可指定另一历史 ID。用户要求恢复时用 `tie_restore({id_or_title, revisionId, expectedUpdatedAt?, actor?})`；建议用 `tie_get.updatedAt` 或 `tie_diff.currentUpdatedAt` 校验当前页。恢复前会留史，恢复整页正文和元数据，不是局部合并；具体步骤见 `tie-memory`。不要为了查看历史或恢复绕过 HTTP 故障确认流程。

连接正常后，查询知识优先使用分类树缩小范围：先 `tie_tree({depth: 1})` 看顶层，再用相关节点 ID 作为 `root` 按层展开。`depth` 范围 `1..8`，默认 `2`，指定根节点计为第一层；`childCount` 和 `childrenTruncated` 提示是否仍有子节点可展开。

用 `tie_search` 的 `root` 搜索选定节点及其后代，按需用 `exclude` 排除无关分支及其后代。ID 优先于标题，标题重名时必须用 ID；检查结果的 `breadcrumb`（分类路径的 `id` / `title`）后按需读全文。局部结果不足再扩大范围，不反复输出全树或混入无关分类。

写入前尽量沿树复用最细且稳定的已有分类，通过 `parentId` 指定父节点。分类不是必填项，没有合适节点仍可直接写入；不自动搬动旧页面，不为每条知识强造多层分类，用户明确需要时才新建分类页。完整检索与写入约定见 `tie-memory`。

服务器凭据能力沿用当前 HTTP 身份和工作区范围：`tie_secret_search` 只返回元数据，`tie_secret_use({secretRef, grantId?})` 只执行所有者已授权的固定 HTTP 操作，`tie_secret_usage` 查看使用记录。没有有效授权时，请所有者到 `/me/` 的「凭据库」授权；不要求用户把原文提供给 Agent，也不降级到本机凭据。密钥不会进入 MCP 响应、页面、历史或知识库导出。完整使用规则见 `tie-memory`。

仅本机桥接需要本机 CLI；缺少时按 Skill `tie-upgrade-cli` 安装或构建。HTTP MCP 使用服务器部署的 CLI，若 `/health` 报告服务端缺少 CLI，请管理员处理，不要求远程用户构建。页面内容只用 `tie_*` 工具读写，不手改 frontmatter。
