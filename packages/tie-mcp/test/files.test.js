import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createWorkspace } from '../src/workspace.js'

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
  assert.ok(copied.url.startsWith('tie://file/'))
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
  assert.ok(linked.entryCount)
  assert.equal(linked.entryCount.files, 2)
  assert.equal(linked.entryCount.dirs, 1)

  const again = ws.files.ingest({ path: folder, mode: 'link' })
  assert.equal(again.created, false)
  assert.equal(again.id, linked.id)

  const copied = ws.files.ingest({ path: folder, mode: 'copy', title: '资料库副本' })
  assert.equal(copied.created, true)
  assert.equal(copied.kind, 'directory')
  assert.notEqual(copied.id, linked.id)
  assert.ok(copied.storedPath.startsWith('.tie/files/'))
  assert.ok(fs.existsSync(path.join(copied.openPath, 'a.txt')))
  assert.ok(fs.existsSync(path.join(copied.openPath, 'nested', 'b.md')))

  const hint = ws.files.openHint(linked.id)
  assert.equal(hint.exists, true)
  assert.match(hint.hint, /文件管理器打开目录/)
})
