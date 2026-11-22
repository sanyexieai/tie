#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createCliPageBackend, resolveTieCli } from './tie-cli.js'
import { createWorkspace } from './workspace.js'

function text(data) {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
  }
}

function requireWorkspaceRoot() {
  const raw = String(process.env.TIE_WORKSPACE || '').trim()
  if (!raw) {
    throw new Error('请设置 TIE_WORKSPACE 为 Tie 工作区根目录（含 pages/）')
  }
  const root = path.resolve(raw)
  const pages = path.join(root, 'pages')
  if (!fs.existsSync(pages) || !fs.statSync(pages).isDirectory()) {
    throw new Error(`工作区无效：未找到 ${pages}`)
  }
  return root
}

function requireCli() {
  const cliPath = resolveTieCli()
  if (!cliPath) {
    throw new Error(
      [
        'tie CLI 未找到（已取消 JS 回退）。',
        '请启用 Skill `tie-upgrade-cli`，或本机执行：',
        '  cargo build -p tie-cli --manifest-path src-tauri/Cargo.toml',
        '  export TIE_CLI=$PWD/src-tauri/target/debug/tie',
        '桌面端：设置 → Agent 知识库 → 重新接入（会写入 TIE_CLI）。',
      ].join('\n'),
    )
  }
  return cliPath
}

function openWorkspace() {
  const root = requireWorkspaceRoot()
  const cliPath = requireCli()
  console.error(`[tie-mcp] backend = tie CLI (${cliPath})`)
  return createCliPageBackend(root, cliPath, {
    // migration stamp 仍由 JS 只读扫描；页面/文件读写只走 CLI
    migrationStatus: (opts) => createWorkspace(root).migrationStatus(opts),
  })
}

function main() {
  let workspace
  try {
    workspace = openWorkspace()
  } catch (error) {
    console.error(`[tie-mcp] ${error.message}`)
    process.exit(1)
  }

  const server = new McpServer({
    name: 'tie',
    version: '0.1.0',
  })

  server.tool(
    'tie_doctor',
    '诊断 Tie MCP 是否接到 Rust CLI、工作区是否可读。升级/接入出问题时先调这个；兼容与配置修复交给 Skill tie-upgrade-cli，不要手改 pages frontmatter。',
    {},
    async () => {
      const cli = resolveTieCli() || workspace.cliPath || null
      let formatCheck = null
      let formatError = null
      if (cli) {
        const result = spawnSync(cli, ['--workspace', workspace.root, 'format', 'check'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, TIE_WORKSPACE: workspace.root },
        })
        const stdout = String(result.stdout || '').trim()
        try {
          formatCheck = stdout ? JSON.parse(stdout) : null
        } catch {
          formatCheck = { raw: stdout }
        }
        if (result.status !== 0) {
          formatError = String(result.stderr || '').trim() || `exit ${result.status}`
        }
      }
      const ok = Boolean(cli) && !formatError
      return text({
        ok,
        workspace: workspace.root,
        backend: 'cli',
        tieCli: cli,
        env: {
          TIE_WORKSPACE: process.env.TIE_WORKSPACE || null,
          TIE_CLI: process.env.TIE_CLI || null,
          TIE_SOURCE_ID: process.env.TIE_SOURCE_ID || process.env.TIE_STORAGE_SOURCE_ID || null,
        },
        formatCheck,
        formatError,
        next: !cli
          ? '缺少 tie CLI：启用 Skill tie-upgrade-cli'
          : (formatError
            ? 'format check 失败：启用 Skill tie-upgrade-cli，按 errors 用 tie_get/tie_write 修复，勿手写 frontmatter'
            : 'MCP 已接到 CLI，可正常使用 tie_* tools'),
      })
    },
  )

  server.tool(
    'tie_list_recent',
    '列出 Tie 工作区最近更新的页面（可选按标签过滤）',
    {
      limit: z.number().int().min(1).max(50).optional().describe('返回条数，默认 20'),
      tag: z.string().optional().describe('按标签精确过滤，如 memory'),
    },
    async ({ limit, tag }) => text(workspace.listRecent({ limit, tag })),
  )

  server.tool(
    'tie_search',
    '在 Tie 本地工作区按关键词/标签搜索页面（标题、标签、正文）',
    {
      query: z.string().optional().describe('关键词；可与 tag 组合'),
      tag: z.string().optional().describe('按标签精确过滤'),
      limit: z.number().int().min(1).max(50).optional().describe('返回条数，默认 12'),
    },
    async ({ query, tag, limit }) => text({
      workspace: workspace.root,
      backend: 'cli',
      results: workspace.search({ query: query ?? '', tag, limit }).map((item) => ({
        ...workspace.summarize(item.page),
        score: item.score,
        snippet: item.snippet,
      })),
    }),
  )

  server.tool(
    'tie_get',
    '按页面 id 或精确标题读取完整 Markdown 页面',
    {
      id_or_title: z.string().describe('页面 id（如 pg_xxx）或精确标题'),
    },
    async ({ id_or_title }) => {
      const page = workspace.getById(id_or_title) || workspace.findByTitle(id_or_title)
      if (!page) return text({ error: `页面不存在：${id_or_title}` })
      return text({
        ...page,
        path: `${workspace.pagesDir}/${page.id}.md`,
        backend: 'cli',
      })
    },
  )

  server.tool(
    'tie_related',
    '查看页面的出链、入链、子页面与同标签邻居',
    {
      id_or_title: z.string().describe('页面 id 或精确标题'),
    },
    async ({ id_or_title }) => text(workspace.related(id_or_title)),
  )

  server.tool(
    'tie_write',
    '安全写入 Tie 页面：自动补全 frontmatter；更新时先归档到 .tie/history。创建需 title；更新传 pageId。正文链接协议：页面用 [[标题]] 或 tie://page/{id}；区外登记用 tie://file/{sourceId}/{id}；区内相对路径用 tie://path/{sourceId}/{相对路径}；图片用 tie://asset/{pageId}/{文件名}。不要用手写 file:///。',
    {
      title: z.string().optional().describe('页面标题；创建时必填'),
      markdown: z.string().optional().describe('Markdown 正文（纯文本，不要传 JSON 包装）'),
      body: z.string().optional().describe('markdown 的别名'),
      pageId: z.string().optional().describe('已有页面 id；提供则更新'),
      tags: z.array(z.string()).optional().describe('标签列表；更新时若省略则保留原标签'),
      parentId: z.string().nullable().optional().describe('父页面 id；传 null 变为顶层'),
      parentTitle: z.string().optional().describe('按标题设置父页面'),
      kind: z.enum(['decision', 'bug', 'preference', 'note']).optional()
        .describe('记忆类型，自动追加 memory 等相关标签'),
      matchTitle: z.boolean().optional().describe('若为 true 且未传 pageId，则按 title 匹配已有页并更新'),
      icon: z.string().optional().describe('可选 emoji 图标'),
    },
    async (args) => text(workspace.writePage(args)),
  )

  server.tool(
    'tie_file_ingest',
    '登记外部文件或目录。mode=link 登记为绝对引用；mode=copy 导入工作区副本。不要手写 file:///。',
    {
      path: z.string().describe('本机文件或目录路径'),
      mode: z.enum(['copy', 'link']).describe('copy=导入副本；link=登记原路径'),
      title: z.string().optional().describe('显示标题'),
    },
    async (args) => text(workspace.files.ingest(args)),
  )

  server.tool(
    'tie_file_get',
    '按 fileId 读取已登记文件资源的元数据',
    {
      fileId: z.string().describe('文件资源 id，如 file_xxx'),
    },
    async ({ fileId }) => {
      const meta = workspace.files.getById(fileId)
      if (!meta) return text({ error: `文件资源不存在：${fileId}` })
      return text(meta)
    },
  )

  server.tool(
    'tie_file_list',
    '列出工作区已登记的文件资源',
    {
      query: z.string().optional().describe('标题/路径/类型关键词'),
      ext: z.string().optional().describe('扩展名过滤，如 pdf'),
      limit: z.number().int().min(1).max(200).optional().describe('返回条数，默认 50'),
    },
    async ({ query, ext, limit }) => text({
      workspace: workspace.root,
      results: workspace.files.list({ query, ext, limit }),
    }),
  )

  server.tool(
    'tie_file_open_hint',
    '返回可打开路径与是否存在；不替用户打开文件',
    {
      fileId: z.string().describe('文件资源 id'),
    },
    async ({ fileId }) => text(workspace.files.openHint(fileId)),
  )

  server.tool(
    'tie_migration_status',
    '查询工作区数据迁移 stamp 与需 Agent 收尾的项。仅当 migration 标了 agentFollowUp 且仍有残留时跟 Skill tie-update。',
    {
      migrationId: z.string().optional().describe('可选，只查某一 migration id'),
      limit: z.number().int().min(1).max(200).optional().describe('残留页条数上限，默认 50'),
    },
    async ({ migrationId, limit }) => text(workspace.migrationStatus({ migrationId, limit })),
  )

  const transport = new StdioServerTransport()
  server.connect(transport).then(() => {
    console.error(`[tie-mcp] ready · workspace=${workspace.root} · backend=cli`)
  }).catch((error) => {
    console.error('[tie-mcp] failed to start', error)
    process.exit(1)
  })
}

main()
