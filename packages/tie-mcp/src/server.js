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
      markdown: z.string().optional().describe('Markdown 正文（纯文本，不要传 JSON 包装）；可省略一级标题，将自动补上'),
      body: z.string().optional().describe('markdown 的别名（同样应为纯 Markdown）'),
      pageId: z.string().optional().describe('已有页面 id；提供则更新'),
      tags: z.array(z.string()).optional().describe('标签列表；更新时若省略则保留原标签'),
      parentId: z.string().nullable().optional().describe('父页面 id；传 null 变为顶层。树只认 frontmatter parent_id，不写父页正文子链接'),
      parentTitle: z.string().optional().describe('按标题设置父页面（推荐）；只写 parent_id'),
      kind: z.enum(['decision', 'bug', 'preference', 'note']).optional()
        .describe('记忆类型，自动追加 memory 等相关标签'),
      matchTitle: z.boolean().optional().describe('若为 true 且未传 pageId，则按 title 匹配已有页并更新'),
      icon: z.string().optional().describe('可选 emoji 图标'),
    },
    async (args) => text(workspace.writePage(args)),
  )

  server.tool(
    'tie_file_ingest',
    '登记外部文件或目录到工作区：mode=copy 导入副本到 .tie/files；mode=link 只记录原路径。目录也可登记；返回 kind/file 元数据与稳定链接 tie://file/{id}。摘要请用 tie_write 写入页面，不要把二进制塞进 markdown，也不要手写 file:/// 链接。',
    {
      path: z.string().describe('本机文件或目录的绝对/相对路径'),
      mode: z.enum(['copy', 'link']).describe('copy=导入工作区副本；link=外链引用原路径（目录推荐 link）'),
      title: z.string().optional().describe('显示标题；默认用文件/目录名'),
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
    '列出工作区已登记的文件资源（可按关键词 / 扩展名过滤）',
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
    '返回可打开路径与是否存在（copy→工作区副本；link→原路径）；不替用户打开文件',
    {
      fileId: z.string().describe('文件资源 id'),
    },
    async ({ fileId }) => text(workspace.files.openHint(fileId)),
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
