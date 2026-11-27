import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import { closeLive } from '../src/live.js'
import { store } from '../src/store.js'
import { frontmatter } from '../src/page-format.js'
import { workspaceSyncManifest } from '../src/sync-manifest.js'
import { saveWorkspacePage } from '../src/workspace-pages.js'

const stamp = '2026-11-27T00:00:00.000Z'
let previousDataDir
let dataDir
let server
let endpoint
let token
let workspaceId

function page(index, markdown = `# Page ${index}\n\nfixture-sensitive-body-${index}`) {
  return { id: `pg_${index}`, title: `Page ${index}`, markdown, icon: '', parentId: null, sortKey: index, tags: [], createdAt: stamp, updatedAt: stamp, deletedAt: null }
}

function request(suffix, options = {}) {
  return fetch(`${endpoint}/api/v1/workspaces/${workspaceId}${suffix}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) },
  })
}

async function manifest(revision) {
  const response = await request(`/sync/manifest${revision ? `?revision=${revision}` : ''}`)
  assert.equal(response.status, 200)
  return response.json()
}

describe('incremental sync manifest', { concurrency: 1 }, () => {
  beforeEach(async () => {
    previousDataDir = process.env.TIE_DATA_DIR
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-sync-manifest-'))
    process.env.TIE_DATA_DIR = dataDir
    server = createApp({ jwtSecret: 'sync-manifest-testing-secret-over-32-characters' }).listen(0, '127.0.0.1')
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    endpoint = `http://127.0.0.1:${server.address().port}`
    const account = await fetch(`${endpoint}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Manifest Owner', email: 'manifest@example.test', password: 'fixture-login-password' }) })
    assert.equal(account.status, 200)
    token = (await account.json()).accessToken
    workspaceId = (await (await fetch(`${endpoint}/api/v1/workspaces`, { headers: { authorization: `Bearer ${token}` } })).json())[0].id
  })

  afterEach(async () => {
    closeLive()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.TIE_DATA_DIR
    else process.env.TIE_DATA_DIR = previousDataDir
  })

  it('returns only opaque versions, answers idle checks with 304, and reads a requested body without loading unrelated pages', async (context) => {
    for (let index = 0; index < 12; index += 1) saveWorkspacePage(workspaceId, page(index))
    const bodies = new Set(fs.readdirSync(store.workspacePagesDir(workspaceId)).map((name) => path.join(store.workspacePagesDir(workspaceId), name)))
    const readFileSync = fs.readFileSync
    const reads = []
    context.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (bodies.has(String(file))) reads.push(String(file))
      return readFileSync(file, ...args)
    })
    const first = await manifest()
    assert.equal(first.version, 1)
    assert.equal(first.pages.length, 12)
    assert.ok(first.pages.every((entry) => Object.keys(entry).sort().join(',') === 'id,version' && /^[a-f0-9]{64}$/.test(entry.version)))
    assert.ok(!JSON.stringify(first).includes('fixture-sensitive'))
    assert.deepEqual(reads, [], 'manifest must not read page bodies')
    const idle = await request(`/sync/manifest?revision=${first.revision}`)
    assert.equal(idle.status, 304)
    assert.equal(await idle.text(), '')
    assert.equal(idle.headers.get('cache-control'), 'no-store')
    assert.deepEqual(reads, [], 'idle polling must not load body content')
    const result = await request('/pages/pg_4')
    assert.equal((await result.json()).markdown, page(4).markdown)
    assert.deepEqual(new Set(reads), new Set([path.join(store.workspacePagesDir(workspaceId), 'Page 4.md')]))
    reads.length = 0
    assert.equal((await request('/pages/pg_missing')).status, 404)
    assert.deepEqual(reads, [], 'a missing page lookup must not scan every body')
    saveWorkspacePage(workspaceId, { ...page(4), markdown: '# Page 4\n\nChanged only this page', updatedAt: '2026-11-27T00:00:01.000Z' })
    assert.deepEqual(new Set(reads), new Set([path.join(store.workspacePagesDir(workspaceId), 'Page 4.md')]), 'saving must derive root .tie entries from metadata')
  })

  it('detects direct page, review, asset and file changes while ignoring sync state and history', async () => {
    saveWorkspacePage(workspaceId, page(0))
    saveWorkspacePage(workspaceId, page(1))
    const first = await manifest()
    const root = store.workspaceDir(workspaceId)
    fs.appendFileSync(path.join(store.workspacePagesDir(workspaceId), 'Page 0.md'), '\nExternal CLI edit without changing updatedAt')
    const second = await manifest(first.revision)
    assert.notEqual(second.pages.find((entry) => entry.id === 'pg_0').version, first.pages.find((entry) => entry.id === 'pg_0').version)
    assert.equal(second.pages.find((entry) => entry.id === 'pg_1').version, first.pages.find((entry) => entry.id === 'pg_1').version)
    assert.deepEqual(second.reviews, first.reviews)

    const review = await request('/pages/pg_0/signals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opinionKind: 'correction', body: 'fixture-sensitive-discussion' }) })
    assert.equal(review.status, 200)
    const reviewed = await manifest()
    assert.deepEqual(reviewed.pages, second.pages)
    assert.notEqual(reviewed.reviews.find((entry) => entry.id === 'pg_0').version, second.reviews.find((entry) => entry.id === 'pg_0').version)
    assert.equal((await request('/pages/pg_0/assets/picture.png', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('fixture-sensitive-asset') })).status, 201)
    assert.deepEqual(await (await request('/pages/pg_0/assets')).json(), { assets: ['picture.png'] }, 'existing clients retain the original response')
    const assetVersions = await (await request('/pages/pg_0/assets?versions=1')).json()
    assert.deepEqual(assetVersions.assets, ['picture.png'])
    assert.deepEqual(assetVersions.versions.map((entry) => entry.name), ['picture.png'])
    assert.match(assetVersions.versions[0].version, /^[a-f0-9]{64}$/)
    const fileId = 'file_0123456789abcdef'
    assert.equal((await request(`/files/${fileId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Private file title', mode: 'copy', kind: 'file', storedPath: `.tie/files/${fileId}/original.bin`, createdAt: stamp, updatedAt: stamp }) })).status, 200)
    assert.equal((await request(`/files/${fileId}/blob/original.bin`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('fixture-sensitive-copy') })).status, 201)
    const resources = await manifest()
    assert.deepEqual(resources.assets.map((entry) => entry.id), ['pg_0'])
    assert.deepEqual(resources.files.map((entry) => entry.id), [fileId])
    for (const canary of ['fixture-sensitive', 'Private file title', 'original.bin', 'picture.png']) assert.ok(!JSON.stringify(resources).includes(canary))
    fs.appendFileSync(path.join(root, '.tie/assets/pg_0/picture.png'), 'new')
    fs.appendFileSync(path.join(root, '.tie/files', fileId, 'original.bin'), 'new')
    const changedResources = await manifest()
    const changedAssetVersions = await (await request('/pages/pg_0/assets?versions=1')).json()
    assert.notEqual(changedAssetVersions.versions[0].version, assetVersions.versions[0].version, 'same-name replacements must change the blob version')
    assert.notEqual(changedResources.assets[0].version, resources.assets[0].version)
    assert.notEqual(changedResources.files[0].version, resources.files[0].version)
    assert.deepEqual(changedResources.pages, resources.pages)
    fs.writeFileSync(path.join(root, '.tie/sync-cursor.json'), '{}')
    fs.mkdirSync(path.join(root, '.tie/history/pg_0'), { recursive: true })
    fs.writeFileSync(path.join(root, '.tie/history/pg_0/old.md'), 'unrelated old revision')
    assert.equal((await request(`/sync/manifest?revision=${changedResources.revision}`)).status, 304)
    const restarted = await import('../src/sync-manifest.js?restart-test')
    assert.deepEqual(restarted.workspaceSyncManifest(workspaceId), changedResources, 'versions must not depend on a server-process epoch')

    const removed = await request('/pages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageIds: ['pg_1'] }) })
    assert.equal(removed.status, 204)
    assert.deepEqual((await manifest()).pages.map((entry) => entry.id), ['pg_0'])
  })

  it('migrates legacy frontmatter once and keeps encrypted page content opaque', async (context) => {
    const ordinary = page(0)
    const legacy = path.join(store.workspacePagesDir(workspaceId), 'legacy.md')
    fs.writeFileSync(legacy, frontmatter(ordinary))
    const encrypted = page(1, '-----BEGIN TIE ENCRYPTED MARKDOWN-----\n{"ciphertext":"fixture-sensitive-ciphertext"}\n-----END TIE ENCRYPTED MARKDOWN-----\n')
    saveWorkspacePage(workspaceId, encrypted)
    const first = await manifest()
    assert.deepEqual(first.pages.map((entry) => entry.id), ['pg_0', 'pg_1'])
    assert.ok(!JSON.stringify(first).includes('fixture-sensitive'))
    const readFileSync = fs.readFileSync
    const reads = []
    context.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (String(file).startsWith(store.workspacePagesDir(workspaceId) + path.sep)) reads.push(file)
      return readFileSync(file, ...args)
    })
    assert.deepEqual(workspaceSyncManifest(workspaceId), first)
    assert.deepEqual(reads, [])
  })

  it('rejects a conditional draft save after the remote page was purged without recreating or changing stored data', async () => {
    const original = page(0)
    const retained = page(1)
    saveWorkspacePage(workspaceId, original)
    saveWorkspacePage(workspaceId, retained)
    assert.equal((await request('/pages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pageIds: [original.id] }) })).status, 204)
    const root = store.workspaceDir(workspaceId)
    const stored = () => Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile()).map((entry) => {
        const file = path.join(entry.parentPath, entry.name)
        return [path.relative(root, file), fs.readFileSync(file).toString('base64')]
      }))
    const before = stored()
    const draft = { ...original, markdown: '# Page 0\n\nUnsaved local draft must remain local', updatedAt: '2026-11-27T00:00:01.000Z' }
    const rejected = await request(`/pages/${original.id}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-unmodified-since': original.updatedAt }, body: JSON.stringify(draft) })
    assert.equal(rejected.status, 409)
    assert.match((await rejected.json()).message, /更新或删除/)
    assert.equal((await request(`/pages/${original.id}`)).status, 404)
    assert.deepEqual((await manifest()).pages.map((entry) => entry.id), [retained.id])
    assert.deepEqual(stored(), before, 'a failed conditional save must not create page, history, reviews or overwrite other data')
    assert.equal((await (await request(`/pages/${retained.id}`)).json()).markdown, retained.markdown)

    for (const index of [2, 3]) {
      const created = await request(`/pages/pg_${index}`, { method: 'PUT', headers: { 'content-type': 'application/json', ...(index === 3 ? { 'x-tie-replication': '1' } : {}) }, body: JSON.stringify(page(index)) })
      assert.equal(created.status, 200, 'new pages without an old-version precondition must still be accepted')
    }
  })

  it('requires workspace ownership and rejects invalid revision values', async () => {
    assert.equal((await fetch(`${endpoint}/api/v1/workspaces/${workspaceId}/sync/manifest`)).status, 401)
    const second = await fetch(`${endpoint}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Other Owner', email: 'other-manifest@example.test', password: 'fixture-login-password' }) })
    const otherToken = (await second.json()).accessToken
    assert.equal((await request('/sync/manifest', { headers: { authorization: `Bearer ${otherToken}` } })).status, 404)
    assert.equal((await request('/sync/manifest?revision=a&revision=b')).status, 400)
    assert.equal((await request(`/sync/manifest?revision=${'x'.repeat(257)}`)).status, 400)
  })
})
