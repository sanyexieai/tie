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

export function buildMcpHandoffPrompt(input: {
  mode: 'http' | 'local'
  workspaceName: string
  workspacePath: string
  mcpUrl?: string | null
  cliPath?: string | null
  clients: McpHandoffClient[]
}) {
  const clients = clientsOrDefault(input.clients)
  const cli = input.cliPath?.trim() || 'tie'
  const cliLine = input.cliPath?.trim()
    ? `tie CLI：${input.cliPath.trim()}`
    : 'tie CLI：未找到。请先构建或安装 tie，或设置 TIE_CLI。'
  const httpLine = input.mcpUrl?.trim()
    ? `后台 HTTP 目前可用：${input.mcpUrl.trim()}。本机 tie mcp 会先用登录会话请求它，不通再读写上面的本地工作区。配置里不要改成只写 url。`
    : '当前没有可用的后台 HTTP。配置仍写本机 tie mcp；后台以后开了，同一次进程会先试 HTTP。'
  return [
    '按 Skill tie-mcp-connect。Cursor 只拉起本机 tie mcp。这个进程先试后台 HTTP，不通再用本地工作区。两种能力都在，不要改成只留 url 或只留本地。',
    '',
    `工作区：${input.workspaceName}`,
    `路径：${input.workspacePath}`,
    cliLine,
    httpLine,
    '不要在本机另起 HTTP，也不要改成 node。令牌不要写进 mcp.json，也不要写进知识库页面。',
    '',
    '客户端配置：',
    ...clients.map((client) => localConfigLine(client, cli, input.workspacePath)),
    '',
    '写完必须新开一个对话。新对话里先 tie_doctor，ok 之后用 tie_search、tie_get、tie_write。不要手改 pages 里的 frontmatter。',
  ].join('\n')
}
