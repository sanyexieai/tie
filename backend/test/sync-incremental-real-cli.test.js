import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('real desktop sync reads only changed resources and leaves idle conflicts metadata-only', { skip: !process.env.TIE_TEST_CLI }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-incremental-sync-'))
  process.env.TIE_DATA_DIR = path.join(data, 'server')
  process.env.TIE_APP_DATA = path.join(data, 'client-session')
  process.env.TIE_ALLOW_WEAK_SECRET = '1'
  const cli = path.resolve(process.env.TIE_TEST_CLI)
  const local = path.join(data, 'client')
  const { createApp } = await import('../src/app.js')
  const { closeLive } = await import('../src/live.js')
  const app = createApp({ jwtSecret: 'incremental-sync-real-cli-fixture-secret' })
  const requests = []
  const server = http.createServer((req, res) => { requests.push(`${req.method} ${req.url.split('?')[0]}`); app(req, res) })
  server.listen(0, '127.0.0.1')
  try {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const endpoint = `http://127.0.0.1:${server.address().port}`
    let token = ''
    async function request(route, body, method = 'POST') {
      const response = await fetch(`${endpoint}${route}`, { method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const result = response.status === 204 ? null : await response.json()
      assert.ok(response.ok, JSON.stringify(result))
      return result
    }
    async function run(args) {
      return new Promise((resolve, reject) => {
        execFile(cli, args, { env: { ...process.env, TIE_MCP_URL: '', TIE_MCP_TOKEN: '', TIE_MCP_TOKEN_FILE: '' }, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) reject(new Error(`${stderr}\n${stdout}`, { cause: error }))
          else { try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) } }
        })
      })
    }
    const account = await request('/api/v1/auth/register', { name: 'IncrementalOwner', email: 'incremental@example.test', password: 'fixture-login-password' })
    token = account.accessToken
    const workspace = (await request('/api/v1/workspaces', undefined, 'GET'))[0]
    const base = `/api/v1/workspaces/${workspace.id}`
    await request('/api/v1/admin/settings', { mcp: { enabled: true, cliPath: cli } }, 'PUT')
    const pages = new Map()
    for (const id of ['pg_incremental_a', 'pg_incremental_b', 'pg_incremental_c']) {
      const page = { id, title: id, markdown: `# ${id}\n\nfixture-body-${id}\n`, icon: '', tags: [], parentId: null,
        sortKey: pages.size, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deletedAt: null }
      pages.set(id, await request(`${base}/pages/${id}`, page, 'PUT'))
    }
    await run(['--source-id', 'src_incremental', 'init', local])
    fs.mkdirSync(process.env.TIE_APP_DATA, { recursive: true })
    fs.writeFileSync(path.join(process.env.TIE_APP_DATA, 'backend-session.json'), JSON.stringify({ endpoint, accessToken: token,
      refreshToken: '', accessExpiresAt: '2999-01-01T00:00:00Z', userId: account.user.id, name: account.user.name, email: account.user.email }), { mode: 0o600 })
    const sync = () => run(['--workspace', local, 'sync', '--backend-url', endpoint, '--backend-workspace', workspace.id])
    const contents = () => requests.filter((entry) => entry.startsWith(`GET ${base}/pages`) || entry.startsWith(`GET ${base}/files`))
    async function settle() {
      for (let attempt = 0; attempt < 4; attempt++) {
        requests.length = 0
        const report = await sync()
        if (!report.changed && contents().length === 0) return
      }
      assert.fail(`sync did not reach an idle metadata-only state: ${requests.join(', ')}`)
    }
    requests.length = 0
    const initial = await sync()
    assert.equal(initial.pulled, 3)
    assert.ok(!requests.includes(`GET ${base}/pages`), 'even bootstrap must fetch bodies by ID, not the whole page collection')
    await settle()
    requests.length = 0
    assert.equal((await sync()).changed, false)
    assert.deepEqual(contents(), [])
    assert.ok(requests.includes(`GET ${base}/sync/manifest`))

    await run(['--workspace', local, 'write', '--page-id', 'pg_incremental_a', '--markdown', 'fixture-local-edit'])
    requests.length = 0
    const parallel = await Promise.all([sync(), sync()])
    assert.equal(parallel.reduce((total, report) => total + report.pushed, 0), 1, 'desktop and MCP processes must serialize one workspace')
    assert.ok(JSON.parse(fs.readFileSync(path.join(local, '.tie/sync-index.json'), 'utf8')))
    assert.ok(JSON.parse(fs.readFileSync(path.join(local, '.tie/sync-cursor.json'), 'utf8')))
    assert.ok(requests.includes(`PUT ${base}/pages/pg_incremental_a`))
    assert.ok(!contents().some((entry) => /pg_incremental_[bc](?:\/|$)/.test(entry)), requests.join(', '))
    await settle()

    async function remoteTool(name, args) {
      const response = await fetch(`${endpoint}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-tie-workspace': workspace.id },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      })
      assert.equal(response.status, 200)
      const result = (await response.json()).result
      assert.equal(result.isError, false, JSON.stringify(result))
      return JSON.parse(result.content[0].text)
    }
    await remoteTool('tie_write', { pageId: 'pg_incremental_b', markdown: 'fixture-remote-cli-edit' })
    requests.length = 0
    const pulled = await sync()
    assert.equal(pulled.pulled, 1)
    assert.deepEqual(pulled.changedPages.map((page) => page.id), ['pg_incremental_b'])
    assert.ok(!contents().some((entry) => /pg_incremental_[ac](?:\/|$)/.test(entry)), requests.join(', '))
    await settle()

    const asset = `${base}/pages/pg_incremental_a/assets/fixture.bin`
    async function saveRemoteAsset(body) {
      const response = await fetch(`${endpoint}${asset}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body })
      assert.equal(response.status, 201)
    }
    await saveRemoteAsset('asset-revision-one')
    await settle()
    const localAsset = path.join(local, '.tie/assets/pg_incremental_a/fixture.bin')
    assert.equal(fs.readFileSync(localAsset, 'utf8'), 'asset-revision-one')
    await saveRemoteAsset('asset-revision-two')
    requests.length = 0
    await sync()
    assert.equal(fs.readFileSync(localAsset, 'utf8'), 'asset-revision-two', 'a changed asset with the same name must be downloaded')
    assert.ok(requests.includes(`GET ${asset}`))
    assert.ok(!contents().some((entry) => /\/pages\/[^/]+$/.test(entry)), 'asset-only changes must not fetch page bodies')
    await settle()
    fs.writeFileSync(localAsset, 'asset-local-update')
    requests.length = 0
    await sync()
    assert.ok(requests.includes(`PUT ${asset}`), 'a local overwrite with the same name must be uploaded')
    assert.equal(await (await fetch(`${endpoint}${asset}`, { headers: { authorization: `Bearer ${token}` } })).text(), 'asset-local-update')
    await settle()

    const latest = await request(`${base}/pages/pg_incremental_b`, undefined, 'GET')
    await request(`${base}/pages/pg_incremental_b/signals`, { id: 'op_incremental', opinionKind: 'correction', body: 'fixture-discussion-only', baseUpdatedAt: latest.updatedAt })
    requests.length = 0
    const discussion = await sync()
    assert.ok(discussion.reviewPageIds.includes('pg_incremental_b'))
    assert.ok(!contents().some((entry) => /\/pages\/[^/]+$/.test(entry)), 'discussion-only changes must not fetch page bodies')
    await settle()

    await remoteTool('tie_page_protection', { id_or_title: 'pg_incremental_c', action: 'convert', encrypted: true, password: 'fixture-page-password' })
    requests.length = 0
    const conflict = await sync()
    assert.deepEqual(conflict.conflicts, ['pg_incremental_c'])
    assert.equal(conflict.protectionConflicts[0].remoteEncrypted, true)
    await settle()
    requests.length = 0
    const idleConflict = await sync()
    assert.deepEqual(idleConflict.conflicts, ['pg_incremental_c'])
    assert.equal(idleConflict.changed, false)
    assert.deepEqual(contents(), [], 'unchanged conflicts must not force another body download')
    assert.ok(requests.every((entry) => !entry.endsWith('/pages')))
    const index = fs.readFileSync(path.join(local, '.tie/sync-index.json'), 'utf8')
    for (const value of ['fixture-body-', 'fixture-local-edit', 'fixture-remote-cli-edit', 'fixture-page-password']) {
      assert.ok(!index.includes(value), 'the synchronization index must not retain document bodies or unlock passwords')
    }
  } finally {
    closeLive()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(data, { recursive: true, force: true })
  }
})
