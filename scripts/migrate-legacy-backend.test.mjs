import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { store } from '../backend/src/store.js'
import { getWorkspacePage, listWorkspacePages, listWorkspaceRevisions, readWorkspaceRevision } from '../backend/src/workspace-pages.js'
import { readWorkspacePageAsset } from '../backend/src/workspace-assets.js'
import { getWorkspaceFile, readWorkspaceFileBlob } from '../backend/src/workspace-files.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requireBackend = createRequire(new URL('../backend/package.json', import.meta.url))
const argon2 = requireBackend('argon2')
const userId = '11111111-1111-4111-8111-111111111111'
const workspaceId = '22222222-2222-4222-8222-222222222222'
const revisionId = '33333333-3333-4333-8333-333333333333'
const copyId = 'file_0011223344556677'
const linkId = 'file_8899aabbccddeeff'
const schema = `
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, password_hash TEXT, created_at TEXT);
CREATE TABLE admin_users (id TEXT PRIMARY KEY, username TEXT, email TEXT, password_hash TEXT, created_at TEXT, is_active INTEGER);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, owner_id TEXT, created_at TEXT, storage_provider_id TEXT);
CREATE TABLE pages (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, icon TEXT, parent_id TEXT, sort_key INTEGER, markdown TEXT, tags TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
CREATE TABLE page_revisions (id TEXT PRIMARY KEY, workspace_id TEXT, page_id TEXT, saved_at TEXT, title TEXT, page_json TEXT);
CREATE TABLE user_storage_providers (id TEXT PRIMARY KEY, workspace_id TEXT, kind TEXT);
`

function fixture(dir, passwordHash) {
  const database = path.join(dir, 'old.sqlite')
  const legacy = path.join(dir, 'old-data')
  const date = '2026-11-25T01:00:00Z'
  const revision = { id: 'pg_legacy', title: '旧标题', icon: '📚', parentId: null, sortKey: 3,
    markdown: '# 旧标题\n\n历史正文\n', tags: ['history'], createdAt: date, updatedAt: date, deletedAt: null }
  const records = {
    users: [[userId, 'user@example.test', 'Reader', passwordHash, date]],
    admin_users: [
      ['44444444-4444-4444-8444-444444444444', 'admin', 'USER@example.test', passwordHash, date, 1],
      ['55555555-5555-4555-8555-555555555555', 'Reader', null, passwordHash, date, 1],
      ['66666666-6666-4666-8666-666666666666', 'Operator', null, passwordHash, date, 1],
    ],
    workspaces: [[workspaceId, '迁移工作区', userId, date, null]],
    pages: [
      ['pg_legacy', workspaceId, '标题', '📚', null, 3, '# 标题\n\n正文\n', '["知识"]', date, date, null],
      ['pg_trash', workspaceId, '回收页', '', 'pg_legacy', 4, '# 回收页\n', '[]', date, date, date],
    ],
    page_revisions: [[revisionId, workspaceId, 'pg_legacy', date, '旧标题', JSON.stringify(revision)]],
    user_storage_providers: [['77777777-7777-4777-8777-777777777777', workspaceId, 's3']],
  }
  const create = spawnSync('python3', ['-c', `
import json, sqlite3, sys
d=json.load(sys.stdin)
with sqlite3.connect(sys.argv[1]) as c:
 c.executescript(d['schema'])
 for table,rows in d['records'].items():
  for row in rows: c.execute('INSERT INTO '+table+' VALUES ('+','.join('?' for _ in row)+')',row)
`, database], { input: JSON.stringify({ schema, records }), encoding: 'utf8' })
  assert.equal(create.status, 0, create.stderr)
  const disk = path.join(legacy, 'users', userId, 'workspaces', workspaceId, '.tie')
  fs.mkdirSync(path.join(disk, 'assets', 'pg_legacy'), { recursive: true })
  fs.writeFileSync(path.join(disk, 'assets', 'pg_legacy', 'image.png'), 'fixture image bytes')
  for (const [id, mode] of [[copyId, 'copy'], [linkId, 'link']]) {
    const location = path.join(disk, 'files', id)
    fs.mkdirSync(location, { recursive: true })
    fs.writeFileSync(path.join(location, 'meta.json'), JSON.stringify({
      id, title: '附件', mode, kind: 'file', ext: 'pdf', mime: 'application/pdf', size: 18,
      sourcePath: '/not-accessed/original.pdf',
      storedPath: mode === 'copy' ? `.tie/files/${id}/original.pdf` : '/not-accessed/original.pdf',
      createdAt: date, updatedAt: date,
    }))
    if (mode === 'copy') fs.writeFileSync(path.join(location, 'original.pdf'), 'fixture copy bytes')
  }
  fs.writeFileSync(path.join(disk, 'files', 'index.json'), '[]')
  return { database, legacy, date }
}

test('migrates a read-only SQLite snapshot with accounts, pages, history, assets and copies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-migration-test-'))
  const previousRoot = process.env.TIE_DATA_DIR
  try {
    const passwordHash = await argon2.hash('fixture-only-password')
    const { database, legacy, date } = fixture(dir, passwordHash)
    const originalHash = createHash('sha256').update(fs.readFileSync(database)).digest('hex')
    const output = path.join(dir, 'new-data')
    const migrated = spawnSync('python3', ['scripts/migrate-legacy-backend.py', '--database', database,
      '--legacy-data-dir', legacy, '--output', output], { cwd: root, encoding: 'utf8' })
    assert.equal(migrated.status, 0, migrated.stderr)
    const counts = JSON.parse(migrated.stdout)
    assert.equal(counts.pages, 2)
    assert.equal(counts.revisions, 1)
    assert.equal(counts.users, 2)
    assert.equal(counts.admins, 2)
    assert.equal(counts.assets, 1)
    assert.equal(counts.copyFiles, 1)
    assert.equal(counts.fileResources, 2)
    assert.equal(counts.linkResources, 1)
    assert.equal(counts.skippedS3Providers, 1)
    assert.equal(counts.skippedProviderBindings, 1)
    assert.equal(migrated.stdout.includes(passwordHash), false)
    assert.equal(migrated.stdout.includes('正文'), false)
    assert.equal(createHash('sha256').update(fs.readFileSync(database)).digest('hex'), originalHash)

    process.env.TIE_DATA_DIR = output
    const users = store.loadUsers()
    const original = users.find((user) => user.id === userId)
    assert.equal(original.role, 'admin')
    assert.equal(original.passwordHash, passwordHash)
    assert.equal(await argon2.verify(original.passwordHash, 'fixture-only-password'), true)
    assert.equal(new Set(users.map((user) => user.email.toLowerCase())).size, users.length)
    assert.equal(users.find((user) => user.name === 'Operator').role, 'admin')
    assert.equal(store.loadWorkspaces()[0].ownerId, userId)
    assert.equal(listWorkspacePages(workspaceId).length, 2)
    const page = getWorkspacePage(workspaceId, 'pg_legacy')
    assert.equal(page.markdown, '# 标题\n\n正文\n')
    assert.deepEqual(page.tags, ['知识'])
    assert.equal(getWorkspacePage(workspaceId, 'pg_trash').deletedAt, date)
    assert.equal(getWorkspacePage(workspaceId, 'pg_trash').parentId, 'pg_legacy')
    assert.equal(listWorkspaceRevisions(workspaceId, 'pg_legacy')[0].id, revisionId)
    assert.equal(readWorkspaceRevision(workspaceId, 'pg_legacy', revisionId).markdown, '# 旧标题\n\n历史正文\n')
    assert.equal(readWorkspacePageAsset(workspaceId, 'pg_legacy', 'image.png').toString(), 'fixture image bytes')
    assert.equal(getWorkspaceFile(workspaceId, copyId).exists, true)
    assert.equal(getWorkspaceFile(workspaceId, linkId).exists, false)
    assert.equal(readWorkspaceFileBlob(workspaceId, copyId).data.toString(), 'fixture copy bytes')

    const refused = spawnSync('python3', ['scripts/migrate-legacy-backend.py', '--database', database,
      '--legacy-data-dir', legacy, '--output', output], { cwd: root, encoding: 'utf8' })
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /new or empty directory/)
    assert.equal(getWorkspacePage(workspaceId, 'pg_legacy').markdown, page.markdown)
  } finally {
    if (previousRoot === undefined) delete process.env.TIE_DATA_DIR
    else process.env.TIE_DATA_DIR = previousRoot
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('exports privately for a separate Node container import', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-migration-export-test-'))
  try {
    const { database, legacy } = fixture(dir, '$argon2id$fixture-hash')
    const exported = path.join(dir, 'export.json')
    const result = spawnSync('python3', ['scripts/migrate-legacy-backend.py', '--database', database,
      '--legacy-data-dir', legacy, '--export-json', exported], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.statSync(exported).mode & 0o777, 0o600)
    assert.equal(JSON.parse(result.stdout).pages, 2)
    fs.mkdirSync(path.join(dir, 'imported'))
    const imported = spawnSync(process.execPath, ['scripts/migrate-legacy-backend.mjs', '--input', exported,
      '--output', path.join(dir, 'imported'), '--legacy-data-dir', legacy], { cwd: root, encoding: 'utf8' })
    assert.equal(imported.status, 0, imported.stderr)
    assert.equal(JSON.parse(imported.stdout).assets, 1)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
