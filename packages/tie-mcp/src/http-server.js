#!/usr/bin/env node
/**
 * Headless online MCP gateway (Streamable HTTP).
 *
 * Env:
 *   TIE_WORKSPACE  — workspace root (required)
 *   TIE_CLI        — optional path to tie binary
 *   TIE_MCP_HOST   — default 127.0.0.1
 *   TIE_MCP_PORT   — default 3927
 *   TIE_MCP_TOKEN  — if set, require Authorization: Bearer <token>
 *
 * Endpoint: http://host:port/mcp
 */
import { createServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { createCliPageBackend, resolveTieCli } from './tie-cli.js'
import { createWorkspace } from './workspace.js'
import { appendAuditEvent, resolveAuditActor } from './audit.js'

function text(data) {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
  }
}

function requireWorkspaceRoot() {
  const raw = String(process.env.TIE_WORKSPACE || '').trim()
  if (!raw) throw new Error('请设置 TIE_WORKSPACE')
  const root = path.resolve(raw)
  if (!fs.existsSync(path.join(root, 'pages'))) throw new Error(`工作区无效：${root}`)
  return root
}

function openBackend() {
  const root = requireWorkspaceRoot()
  const cliPath = resolveTieCli()
  if (!cliPath) throw new Error('tie CLI 未找到，请设置 TIE_CLI 或先构建 tie-cli')
  console.error(`[tie-mcp-http] backend = tie CLI (${cliPath})`)
  return createCliPageBackend(root, cliPath, {
    migrationStatus: (opts) => createWorkspace(root).migrationStatus(opts),
  })
}

function buildMcpServer(workspace) {
  const server = new McpServer({ name: 'tie', version: '1.0.49' })

  server.tool('tie_list_recent', '最近更新的页面', {
    limit: z.number().int().min(1).max(50).optional(),
    tag: z.string().optional(),
  }, async ({ limit, tag }) => text(workspace.listRecent({ limit, tag })))

  server.tool('tie_search', '搜索页面', {
    query: z.string().optional(),
    tag: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }, async ({ query, tag, limit }) => text(workspace.search({ query, tag, limit })))

  server.tool('tie_get', '读取页面', {
    idOrTitle: z.string(),
  }, async ({ idOrTitle }) => text(workspace.getById(idOrTitle)))

  server.tool('tie_write', '写入页面', {
    title: z.string().optional(),
    pageId: z.string().optional(),
    markdown: z.string().optional(),
    tags: z.array(z.string()).optional(),
    parentId: z.string().nullable().optional(),
    parentTitle: z.string().optional(),
    matchTitle: z.boolean().optional(),
    actor: z.string().optional(),
  }, async (args) => {
    const saved = workspace.writePage(args)
    appendAuditEvent(workspace.root, {
      type: 'write',
      actor: resolveAuditActor(args.actor),
      pageId: saved?.id,
      title: saved?.title,
      status: 'applied',
    })
    return text(saved)
  })

  server.tool('tie_related', '相关页面', {
    idOrTitle: z.string(),
  }, async ({ idOrTitle }) => text(workspace.related(idOrTitle)))

  server.tool('tie_tree', '页面树', {
    root: z.string().optional(),
  }, async ({ root }) => text(workspace.tree(root)))

  server.tool('tie_export', '导出页面闭包', {
    page: z.string(),
    depth: z.number().optional(),
    withChildren: z.boolean().optional(),
    out: z.string().optional(),
  }, async (args) => text(workspace.exportClosure(args)))

  server.tool('tie_import', '导入闭包目录', {
    path: z.string(),
    strategy: z.enum(['skip', 'overwrite', 'new-id']).optional(),
  }, async (args) => text(workspace.importClosure(args)))

  return server
}

async function main() {
  const workspace = openBackend()
  const host = process.env.TIE_MCP_HOST || '127.0.0.1'
  const port = Number(process.env.TIE_MCP_PORT || 3927)
  const token = String(process.env.TIE_MCP_TOKEN || '').trim()

  const httpServer = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'tie-mcp-http', workspace: workspace.root }))
      return
    }
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end('not found')
      return
    }
    if (token) {
      const header = String(req.headers.authorization || '')
      if (header !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'unauthorized' }))
        return
      }
    }
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      const server = buildMcpServer(workspace)
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (error) {
      console.error('[tie-mcp-http]', error)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }))
      }
    }
  })

  httpServer.listen(port, host, () => {
    console.error(`[tie-mcp-http] http://${host}:${port}/mcp workspace=${workspace.root}`)
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
