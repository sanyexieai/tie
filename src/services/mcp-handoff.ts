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

type McpHandoffInput = {
  mode: 'http'
  mcpUrl: string
} | {
  mode: 'local'
  workspaceName: string
  workspacePath: string
  cliPath: string
  clients: McpHandoffClient[]
}

export function buildMcpHandoffPrompt(input: McpHandoffInput) {
  if (input.mode === 'http') {
    return [
      '本次 Tie 接入方式已确定为原生 HTTP MCP，按以下参数配置当前 Agent 客户端。',
      '',
      `MCP 地址：${input.mcpUrl.trim()}`,
      '授权：Authorization: Bearer <MCP token>。由用户在同一服务器的 /me/ 页面签发并提供令牌，令牌已绑定工作区。',
      '使用客户端原生 HTTP MCP 配置和 Bearer 凭据管理，连接上述远程地址。',
      '真实令牌通过客户端凭据管理或私有环境变量提供，不写进提示词、共享配置、知识库或日志。',
      '',
      '配置后新开 Agent 会话，调用 tie_doctor，必须看到 ok: true、transport: "http"；再读取分类树和一篇页面验证真实访问。工具列表成功不代表连接正常。',
      '检索先用 tie_tree 按层选择分类，再用 tie_search 的 root/exclude 缩小范围，必要时 tie_get 读全文；写入尽量通过 parentId 归入已有分类。',
    ].join('\n')
  }
  const clients = clientsOrDefault(input.clients)
  const cli = input.cliPath.trim()
  return [
    '本次 Tie 接入方式已确定为本机 MCP 桥接，按以下参数配置当前 Agent 客户端。',
    '',
    `工作区：${input.workspaceName}`,
    `路径：${input.workspacePath}`,
    `tie CLI：${cli}`,
    '服务器连接、会话授权和实际数据通道由此 MCP 进程处理，按工具返回结果继续操作。',
    '',
    '客户端配置：',
    ...clients.map((client) => localConfigLine(client, cli, input.workspacePath)),
    '',
    '配置后新开一个对话，调用 tie_doctor 确认 ok 并检查实际 transport，再读取分类树和一篇页面验证真实访问。检索先用 tie_tree 选择分类，再用 tie_search 的 root/exclude 和 tie_get；写入尽量指定 parentId。不要手改 pages 里的 frontmatter。',
  ].join('\n')
}
