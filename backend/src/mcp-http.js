import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const state = {
  enabled: false,
  running: false,
  error: null,
  port: 3927,
}

export function mcpEnabledFromEnv(env = process.env) {
  const raw = String(env.TIE_MCP_HTTP || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

export function defaultMcpServerPath() {
  return fileURLToPath(new URL('../../packages/tie-mcp/src/http-server.js', import.meta.url))
}

export function resolveMcpLaunch(env = process.env) {
  const workspace = String(env.TIE_WORKSPACE || '').trim()
  const cli = String(env.TIE_CLI || '').trim()
  const server = String(env.TIE_MCP_SERVER || '').trim() || defaultMcpServerPath()
  const port = Number(env.TIE_MCP_PORT || 3927)
  if (!workspace || !fs.existsSync(path.join(workspace, 'pages'))) {
    return { ok: false, error: '未设置有效的 TIE_WORKSPACE（目录里需要有 pages/）', port, server, workspace, cli }
  }
  if (!cli || !fs.existsSync(cli)) {
    return { ok: false, error: '未设置有效的 TIE_CLI', port, server, workspace, cli }
  }
  if (!fs.existsSync(server)) {
    return { ok: false, error: '找不到 tie-mcp HTTP 入口', port, server, workspace, cli }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'TIE_MCP_PORT 无效', port, server, workspace, cli }
  }
  return { ok: true, error: null, port, server, workspace, cli }
}

export function mcpStatus() {
  return {
    enabled: state.enabled,
    running: state.running,
    error: state.error,
    port: state.port,
  }
}

export function mcpUrlForRequest(req) {
  if (!state.running) return null
  const forwarded = req.headers?.['x-forwarded-proto']
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded) || req.protocol || 'http'
  const hostHeader = req.headers?.['x-forwarded-host'] || req.headers?.host
  if (!hostHeader) return null
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader
  return `${proto}://${host}/mcp`
}

export function startMcpHttp(env = process.env) {
  state.enabled = true
  const launch = resolveMcpLaunch(env)
  state.port = launch.port
  if (!launch.ok) {
    state.running = false
    state.error = launch.error
    return mcpStatus()
  }
  if (state.running && childAlive()) return mcpStatus()
  const child = spawn(process.execPath, [launch.server], {
    env: {
      ...env,
      TIE_WORKSPACE: launch.workspace,
      TIE_CLI: launch.cli,
      TIE_MCP_HOST: '127.0.0.1',
      TIE_MCP_PORT: String(launch.port),
    },
    stdio: 'inherit',
  })
  state.child = child
  state.running = true
  state.error = null
  child.on('exit', () => {
    if (state.child === child) {
      state.running = false
      state.child = null
      if (!state.error) state.error = 'MCP HTTP 进程已退出'
    }
  })
  return mcpStatus()
}

function childAlive() {
  return Boolean(state.child && state.child.exitCode == null && !state.child.killed)
}

export function proxyMcpRequest(req, res) {
  if (!state.running) {
    res.status(503).json({ message: state.error || 'MCP HTTP 未启动' })
    return
  }
  const headers = { ...req.headers, host: `127.0.0.1:${state.port}` }
  const proxy = http.request({
    hostname: '127.0.0.1',
    port: state.port,
    path: req.originalUrl || req.url,
    method: req.method,
    headers,
  }, (upstream) => {
    res.writeHead(upstream.statusCode || 502, upstream.headers)
    upstream.pipe(res)
  })
  proxy.on('error', () => {
    if (!res.headersSent) res.status(502).json({ message: 'MCP HTTP 转发失败' })
  })
  req.pipe(proxy)
}
