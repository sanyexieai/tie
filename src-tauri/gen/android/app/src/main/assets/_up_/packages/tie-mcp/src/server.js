#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createWorkspace } from './workspace.js'

function text(data) {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
  }
}

function main() {
  let workspace
  try {
    workspace = createWorkspace(process.env.TIE_WORKSPACE)
  } catch (error) {
    console.error(`[tie-mcp] ${error.message}`)
    console.error('[tie-mcp] 设置示例: TIE_WORKSPACE=/path/to/workspace node packages/tie-mcp/src/server.js')
    process.exit(1)
  }

  const server = new McpServer({
    name: 'tie',
    version: '0.1.0',
  })

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
    '安全写入 Tie 页面：自动补全 frontmatter；更新时先归档到 .tie/history。创建需 title；更新传 pageId。',
    {
      title: z.string().optional().describe('页面标题；创建时必填'),
      markdown: z.string().optional().describe('Markdown 正文；可省略一级标题，将自动补上'),
      body: z.string().optional().describe('markdown 的别名'),
      pageId: z.string().optional().describe('已有页面 id；提供则更新'),
      tags: z.array(z.string()).optional().describe('标签列表；更新时若省略则保留原标签'),
      parentId: z.string().nullable().optional().describe('父页面 id；传 null 变为顶层。树以 parent_id 为准，Tie 会按 id 补全父页子链接'),
      parentTitle: z.string().optional().describe('按标题设置父页面（推荐）；只写 parent_id，不必手写子链接'),
      kind: z.enum(['decision', 'bug', 'preference', 'note']).optional()
        .describe('记忆类型，自动追加 memory 等相关标签'),
      matchTitle: z.boolean().optional().describe('若为 true 且未传 pageId，则按 title 匹配已有页并更新'),
      icon: z.string().optional().describe('可选 emoji 图标'),
    },
    async (args) => text(workspace.writePage(args)),
  )

  const transport = new StdioServerTransport()
  server.connect(transport).then(() => {
    console.error(`[tie-mcp] ready · workspace=${workspace.root}`)
  }).catch((error) => {
    console.error('[tie-mcp] failed to start', error)
    process.exit(1)
  })
}

main()
