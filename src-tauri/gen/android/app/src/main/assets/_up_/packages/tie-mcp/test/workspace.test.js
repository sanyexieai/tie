import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createWorkspace } from '../src/workspace.js'
import { frontmatter, parsePage } from '../src/page-format.js'

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-mcp-'))
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true })
  return root
}

test('parse/frontmatter roundtrip', () => {
  const raw = frontmatter({
    id: 'pg_demo',
    title: 'Demo',
    icon: '',
    parentId: null,
    sortKey: 1,
    markdown: '# Demo\n\nhello [[Other]]\n',
    tags: ['memory', 'decision'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    storageSourceId: 'src_local',
  })
  const page = parsePage(raw)
  assert.equal(page.id, 'pg_demo')
  assert.equal(page.title, 'Demo')
  assert.deepEqual(page.tags, ['memory', 'decision'])
})

test('search write related on local workspace', () => {
  const root = makeWorkspace()
  const ws = createWorkspace(root)

  const created = ws.writePage({
    title: 'ADR 本地优先',
    markdown: '决定：MCP 只读写本地 pages。\n\n参见 [[排障手册]]',
    kind: 'decision',
  })
  assert.equal(created.created, true)
  assert.ok(created.page.tags.includes('memory'))
  assert.ok(created.page.tags.includes('decision'))

  const manual = ws.writePage({
    title: '排障手册',
    body: '常见问题：图标缓存。',
    tags: ['ops'],
  })

  // fix link target exists
  ws.writePage({
    pageId: created.page.id,
    title: 'ADR 本地优先',
    markdown: `# ADR 本地优先\n\n决定：MCP 只读写本地 pages。\n\n参见 [[排障手册]] 与 tie://page/${manual.page.id}\n`,
  })

  const hits = ws.search({ query: '本地优先' })
  assert.ok(hits.some((item) => item.page.id === created.page.id))

  const byTag = ws.search({ tag: 'decision' })
  assert.equal(byTag.length, 1)

  const rel = ws.related(created.page.id)
  assert.ok(rel.outgoing.some((item) => item.id === manual.page.id))

  const got = ws.getById(created.page.id)
  assert.ok(got.markdown.includes('MCP'))

  // history archived on update
  const historyDir = path.join(root, '.tie', 'history', created.page.id)
  assert.ok(fs.existsSync(historyDir))
  assert.ok(fs.readdirSync(historyDir).some((name) => name.endsWith('.md')))
})

test('writePage sets parentId from parentTitle without rewriting parent markdown', () => {
  const root = makeWorkspace()
  const ws = createWorkspace(root)

  const hub = ws.writePage({
    title: '产品索引',
    markdown: '# 产品索引\n\n索引页。\n',
  })
  const before = ws.getById(hub.page.id).markdown

  const child = ws.writePage({
    title: '子页甲',
    parentTitle: '产品索引',
    markdown: '# 子页甲\n\n内容。\n',
    kind: 'note',
  })
  assert.equal(child.page.parentId, hub.page.id)
  assert.equal(ws.getById(hub.page.id).markdown, before)
})
