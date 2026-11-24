export interface McpHandoffClient {
  id: string
  label: string
  configPath?: string | null
}

const DEFAULT_CONFIG: Record<string, string> = {
  cursor: '~/.cursor/mcp.json',
  codex: '~/.codex/config.toml',
  claude: '~/.claude.json',
}

const ACTOR: Record<string, string> = {
  cursor: 'Cursor',
  codex: 'Codex',
  claude: 'Claude Code',
}

function clientsOrDefault(clients: McpHandoffClient[]) {
  return clients.length
    ? clients
    : [
      { id: 'cursor', label: 'Cursor' },
      { id: 'codex', label: 'Codex' },
      { id: 'claude', label: 'Claude Code' },
    ]
}

function localConfigLine(client: McpHandoffClient, cli: string, workspace: string) {
  const actor = ACTOR[client.id] ?? client.label
  const config = client.configPath?.trim() || DEFAULT_CONFIG[client.id] || '该客户端的 MCP 配置文件'
  const shape = client.id === 'claude'
    ? `写 type "stdio"、command "${cli}"、args ["mcp"]。`
    : `写 command "${cli}"、args ["mcp"]，不要写 url。`
  return `- ${actor}：${config}。${shape} 环境变量 TIE_WORKSPACE 为 "${workspace}"。TIE_ACTOR 用「${actor}」，不要写「我」。不要写 command 为 node。`
}

function clientConfigLine(client: McpHandoffClient, url: string) {
  const actor = ACTOR[client.id] ?? client.label
  const config = client.configPath?.trim() || DEFAULT_CONFIG[client.id] || '该客户端的 MCP 配置文件'
  const shape = client.id === 'codex'
    ? `在 [mcp_servers.tie] 写 url = "${url}"，不要写 command。`
    : client.id === 'claude'
      ? `在 mcpServers.tie 写 type "http" 和 url "${url}"，不要写 command。`
      : `在 mcpServers.tie 写 url "${url}"，不要写 command 或 args。`
  return `- ${actor}：${config}。${shape} TIE_ACTOR 用「${actor}」，不要写「我」。`
}

export function buildMcpHandoffPrompt(input: {
  mode: 'http' | 'local'
  workspaceName: string
  workspacePath: string
  mcpUrl?: string | null
  cliPath?: string | null
  clients: McpHandoffClient[]
}) {
  const clients = clientsOrDefault(input.clients)
  const usingHttp = input.mode === 'http' && Boolean(input.mcpUrl?.trim())
  const cliLine = input.cliPath?.trim()
    ? `tie CLI：${input.cliPath.trim()}`
    : 'tie CLI：未找到。请先构建或安装 tie，或设置 TIE_CLI。'
  if (!usingHttp) {
    const cli = input.cliPath?.trim() || 'tie'
    return [
      '按 Skill tie-mcp-connect。当前没有后台 MCP HTTP。本机 tie 自己提供 MCP：客户端启动这个程序的 mcp 子命令，不要在本机再听 HTTP 端口。',
      '',
      `工作区：${input.workspaceName}`,
      `路径：${input.workspacePath}`,
      cliLine,
      '',
      '客户端配置：',
      ...clients.map((client) => localConfigLine(client, cli, input.workspacePath)),
      '',
      '写完必须新开一个对话。新对话里先 tie_doctor，ok 之后用 tie_search、tie_get、tie_write。不要手改 pages 里的 frontmatter。',
      '若用户之后给出后台根地址，先 GET {后台}/health。mcp.running 为 true 且 mcp.url 有值时，改成那个 url，去掉 command。',
    ].join('\n')
  }

  const url = input.mcpUrl!.trim()
  const healthUrl = `${new URL(url).origin}/health`
  return [
    '按 Skill tie-mcp-connect。当前建议：后台 MCP HTTP。',
    '',
    `工作区：${input.workspaceName}`,
    `路径：${input.workspacePath}`,
    `建议 MCP 地址：${url}`,
    `健康检查：GET ${healthUrl}。mcp.running 为 true 且 mcp.url 有值时，配置就用 mcp.url。`,
    cliLine,
    '健康检查不再提供地址时，改回本机 MCP：command 用上面的 tie，args 为 ["mcp"]，并设置 TIE_WORKSPACE。不要在本机另起 HTTP，也不要改成 node。',
    '若服务设置了 TIE_MCP_TOKEN，请求头加 Authorization: Bearer <token>，不要把 token 写进知识库页面。',
    '',
    '客户端配置写成这个地址：',
    ...clients.map((client) => clientConfigLine(client, url)),
    '',
    '已有 tie_* 工具且 tie_doctor 为 ok 时保持现状，除非用户要切换，或健康检查不再给出 mcp.url。',
    '切换后告诉用户必须新开一个对话，当前对话加载不到新的 MCP。',
    '新对话里先 tie_doctor。ok 为 true 后，用 tie_search、tie_get、tie_write、tie_list_recent 读写上面的工作区。不要手改 pages 里的 frontmatter。',
  ].join('\n')
}
