import { spawn } from 'node:child_process'
import jwt from 'jsonwebtoken'
import { detectCli, loadSettings } from './settings.js'
import { findMcpToken, touchMcpToken } from './mcp-tokens.js'
import { store } from './store.js'
import { callVaultTool, isVaultTool, vaultTools } from './vault-mcp.js'

const LOCAL_FILE_TOOLS = new Set(['tie_file_ingest', 'tie_file_open_hint', 'tie_export', 'tie_import'])

export function mcpStatus() {
  const settings = loadSettings()
  const cli = detectCli(settings.mcp.cliPath)
  return {
    enabled: settings.mcp.enabled,
    running: settings.mcp.enabled && cli.ok,
    error: settings.mcp.enabled && !cli.ok ? cli.error : null,
    transport: 'tie-cli',
    cli: cli.path,
  }
}

export function mcpUrlForRequest(req) {
  const status = mcpStatus()
  if (!status.enabled) return null
  const forwarded = req.headers?.['x-forwarded-proto']
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded) || req.protocol || 'http'
  const hostHeader = req.headers?.['x-forwarded-host'] || req.headers?.host
  if (!hostHeader) return null
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader
  return `${proto}://${host}/mcp`
}

export function exchangeWithTie(executable, args, message, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const script = executable.toLowerCase().endsWith('.cmd') || executable.toLowerCase().endsWith('.bat')
    const child = script
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', executable, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: mcpChildEnv() })
      : spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env: mcpChildEnv() })
    let out = ''
    let err = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(reject, new Error('tie mcp 超时'))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8') })
    child.on('error', (error) => finish(reject, error))
    child.on('close', () => {
      const line = out.split(/\r?\n/).map((item) => item.trim()).find((item) => item.startsWith('{'))
      if (!line) {
        finish(reject, new Error(err.trim() || 'tie mcp 没有返回'))
        return
      }
      try {
        finish(resolve, JSON.parse(line))
      } catch (error) {
        finish(reject, error)
      }
    })
    child.stdin.write(`${JSON.stringify(message)}\n`)
    child.stdin.end()
  })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function bearer(req) {
  const header = req.headers?.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

function mcpChildEnv() {
  return { ...process.env, TIE_MCP_VIA: 'http' }
}

function headerValue(req, name) {
  const value = req.headers?.[name]
  return String(Array.isArray(value) ? value[0] : value ?? '').trim()
}

function resolveCaller(req, jwtSecret) {
  const rawToken = bearer(req)
  if (!rawToken) return { error: 401, message: '需要登录会话或 MCP 令牌' }
  const token = findMcpToken(rawToken)
  if (token) {
    const workspace = store.loadWorkspaces().find((item) => item.id === token.workspaceId && item.ownerId === token.userId)
    if (!workspace) return { error: 404, message: '这个令牌绑定的工作区已经不存在' }
    const user = store.loadUsers().find((item) => item.id === token.userId)
    if (!user || user.disabled) return { error: 403, message: '账号已停用' }
    return { workspace, userId: user.id, principal: { type: 'mcp-token', id: token.id }, touch: token.id }
  }
  let payload
  try {
    payload = jwt.verify(rawToken, jwtSecret)
  } catch {
    return { error: 401, message: '登录已失效' }
  }
  const user = store.loadUsers().find((item) => item.id === payload.sub)
  if (!user) return { error: 401, message: '用户不存在' }
  if (user.disabled) return { error: 403, message: '账号已停用' }
  const workspaceId = headerValue(req, 'x-tie-workspace')
  if (!workspaceId) return { error: 400, message: '缺少工作区' }
  const workspace = store.loadWorkspaces().find((item) => item.id === workspaceId && item.ownerId === user.id)
  if (!workspace) return { error: 404, message: '工作区不存在' }
  return { workspace, userId: user.id, principal: { type: 'session', id: payload.sid || '' }, touch: null }
}

export async function handleMcpRequest(req, res, jwtSecret) {
  res.set('Cache-Control', 'no-store')
  const status = mcpStatus()
  if (!status.enabled) {
    res.status(503).json({ message: 'MCP 未开启。请管理员在服务设置里打开。' })
    return
  }
  if (!status.running || !status.cli) {
    res.status(503).json({ message: status.error || '未找到 tie-cli' })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ message: 'MCP 使用 POST，正文是一条 JSON-RPC 消息' })
    return
  }
  const caller = resolveCaller(req, jwtSecret)
  if (caller.error) {
    res.status(caller.error).json({ message: caller.message })
    return
  }
  const workspace = caller.workspace
  let message
  try {
    message = JSON.parse(await readBody(req) || 'null')
  } catch {
    res.status(400).json({ message: 'MCP 正文不是 JSON' })
    return
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    res.status(400).json({ message: 'MCP 每次只接收一条 JSON-RPC 消息' })
    return
  }
  // CLI 不回应通知；HTTP 在鉴权后直接确认接收，不能把空 stdout 当作上游失败。
  if (message.jsonrpc === '2.0' && !Object.hasOwn(message, 'id')
      && typeof message.method === 'string' && message.method.startsWith('notifications/')) {
    if (caller.touch) touchMcpToken(caller.touch)
    res.status(202).end()
    return
  }
  if (message.method === 'tools/call' && LOCAL_FILE_TOOLS.has(message.params?.name)) {
    res.json({
      jsonrpc: '2.0', id: message.id ?? null,
      result: { isError: true, content: [{ type: 'text', text: '此 HTTP MCP 连接不提供本机文件操作，包括文件登记、打开提示及导入导出。请使用此连接提供的知识库工具。' }] },
    })
    return
  }
  if (message.method === 'tools/call' && isVaultTool(message.params?.name)) {
    const result = await callVaultTool({ userId: caller.userId, workspaceId: workspace.id, principal: caller.principal }, message.params.name, message.params.arguments)
    if (caller.touch) touchMcpToken(caller.touch)
    res.json({ jsonrpc: '2.0', id: message.id ?? null, result })
    return
  }
  const workspaceDir = store.workspaceDir(workspace.id)
  try {
    const response = await exchangeWithTie(status.cli, ['--workspace', workspaceDir, 'mcp'], message)
    if (message.method === 'tools/list' && Array.isArray(response.result?.tools)) {
      response.result.tools = [...response.result.tools.filter((tool) => !LOCAL_FILE_TOOLS.has(tool.name) && !isVaultTool(tool.name)), ...vaultTools]
    }
    if (caller.touch) touchMcpToken(caller.touch)
    res.json(response)
  } catch (error) {
    res.status(502).json({ message: error instanceof Error ? error.message : 'tie mcp 调用失败' })
  }
}
