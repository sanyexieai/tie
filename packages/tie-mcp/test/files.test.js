import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createWorkspace } from '../src/workspace.js'
import { frontmatter } from '../src/page-format.js'

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-mcp-files-'))
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true })
  return root
}

test('file ingest copy and link with distinct modes and idempotency', () => {
  const root = makeWorkspace()
  const ws = createWorkspace(root)
  const source = path.join(root, 'book.pdf')
  fs.writeFileSync(source, '%PDF-1.4 demo content')

  const copied = ws.files.ingest({ path: source, mode: 'copy', title: 'Demo Book' })
  assert.equal(copied.created, true)
  assert.equal(copied.mode, 'copy')
  assert.equal(copied.ext, 'pdf')
  assert.equal(copied.mime, 'application/pdf')
  assert.ok(copied.url.startsWith('tie://path/'))
  assert.ok(copied.url.includes('.tie/files/'))
  assert.ok(fs.existsSync(copied.openPath))
  assert.ok(copied.storedPath.startsWith('.tie/files/'))

  const again = ws.files.ingest({ path: source, mode: 'copy' })
  assert.equal(again.created, false)
  assert.equal(again.id, copied.id)

  const linked = ws.files.ingest({ path: source, mode: 'link', title: 'Demo Book Link' })
  assert.equal(linked.created, true)
  assert.equal(linked.mode, 'link')
  assert.notEqual(linked.id, copied.id)
  assert.equal(path.resolve(linked.storedPath), path.resolve(source))

  const listed = ws.files.list({ ext: 'pdf' })
  assert.equal(listed.length, 2)
  assert.ok(listed.some((item) => item.mode === 'copy'))
  assert.ok(listed.some((item) => item.mode === 'link'))

  const got = ws.files.getById(copied.id)
  assert.equal(got.id, copied.id)

  const hint = ws.files.openHint(linked.id)
  assert.equal(hint.exists, true)
  assert.match(hint.hint, /系统默认应用打开/)
})

test('file ingest text preview and rejects missing path', () => {
  const root = makeWorkspace()
  const ws = createWorkspace(root)
  const note = path.join(root, 'notes.txt')
  fs.writeFileSync(note, 'hello resource preview\nline 2')

  const ingested = ws.files.ingest({ path: note, mode: 'copy' })
  assert.equal(ingested.ext, 'txt')
  assert.equal(ingested.kind, 'file')
  assert.ok(ingested.preview?.includes('hello resource preview'))

  assert.throws(() => ws.files.ingest({ path: path.join(root, 'missing.bin'), mode: 'link' }), /不存在/)
  assert.throws(() => ws.files.ingest({ path: note, mode: 'mirror' }), /copy 或 link/)
})

test('directory ingest link and copy', () => {
  const root = makeWorkspace()
  const ws = createWorkspace(root)
  const folder = path.join(root, 'library')
  fs.mkdirSync(folder)
  fs.writeFileSync(path.join(folder, 'a.txt'), 'alpha')
  fs.mkdirSync(path.join(folder, 'nested'))
  fs.writeFileSync(path.join(folder, 'nested', 'b.md'), '# beta')

  const linked = ws.files.ingest({ path: folder, mode: 'link', title: '资料库' })
  assert.equal(linked.created, true)
  assert.equal(linked.kind, 'directory')
  assert.equal(linked.ext, 'dir')
  assert.equal(linked.mime, 'inode/directory')
  assert.equal(linked.title, '资料库')
  assert.ok(linked.url.startsWith('tie://file/'))
  assert.equal(path.resolve(linked.openPath), path.resolve(folder))
  assert.ok(linked.preview?.includes('a.txt'))
  // link 不递归扫树（避免大目录卡死）；entryCount 仅 copy 需要
  assert.equal(linked.entryCount, null)

  const again = ws.files.ingest({ path: folder, mode: 'link' })
  assert.equal(again.created, false)
  assert.equal(again.id, linked.id)

  const copied = ws.files.ingest({ path: folder, mode: 'copy', title: '资料库副本' })
  assert.equal(copied.created, true)
  assert.equal(copied.kind, 'directory')
  assert.notEqual(copied.id, linked.id)
  assert.ok(copied.storedPath.startsWith('.tie/files/'))
  assert.ok(copied.url.startsWith('tie://path/'))
  assert.ok(copied.entryCount)
  assert.equal(copied.entryCount.files, 2)
  assert.equal(copied.entryCount.dirs, 1)
  assert.ok(fs.existsSync(path.join(copied.openPath, 'a.txt')))
  assert.ok(fs.existsSync(path.join(copied.openPath, 'nested', 'b.md')))

  const hint = ws.files.openHint(linked.id)
  assert.equal(hint.exists, true)
  assert.match(hint.hint, /文件管理器打开目录/)
})

test('copy rejects directories deeper than 8 levels', () => {
  const root = makeWorkspace()
  const ws = createWorkspace(root)
  const src = path.join(root, 'tree')
  fs.mkdirSync(src)
  let current = src
  for (let i = 0; i < 9; i += 1) {
    current = path.join(current, `l${i}`)
    fs.mkdirSync(current)
  }
  fs.writeFileSync(path.join(current, 'a.txt'), 'x')
  assert.throws(
    () => ws.files.ingest({ path: src, mode: 'copy' }),
    /不能超过 8 层/,
  )
  const linked = ws.files.ingest({ path: src, mode: 'link' })
  assert.equal(linked.mode, 'link')
})

test('ingest urls include source id inferred from pages', () => {
  const root = makeWorkspace()
  const sourceId = 'src_local_2e27348a0aa628a6'
  fs.writeFileSync(path.join(root, 'pages', 'pg_home.md'), frontmatter({
    id: 'pg_home',
    title: 'Home',
    icon: '',
    parentId: null,
    sortKey: 0,
    markdown: '# Home\n',
    tags: [],
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    deletedAt: null,
    storageSourceId: sourceId,
    storageSourceIds: [sourceId],
  }))
  const ws = createWorkspace(root)
  const file = path.join(root, 'note.txt')
  fs.writeFileSync(file, 'hello')
  const copied = ws.files.ingest({ path: file, mode: 'copy' })
  assert.equal(copied.sourceId, sourceId)
  assert.ok(copied.url.includes(encodeURIComponent(sourceId)))
  const linked = ws.files.ingest({ path: file, mode: 'link' })
  assert.ok(linked.url.startsWith(`tie://file/${encodeURIComponent(sourceId)}/`))
  const meta = JSON.parse(fs.readFileSync(path.join(root, '.tie', 'files', linked.id, 'meta.json'), 'utf8'))
  assert.equal(meta.sourceId, sourceId)
  assert.equal(meta.locator.type, 'desktop')
  assert.ok(meta.locator.desktopPath)
  assert.ok(meta.locator.displayPath)
})
