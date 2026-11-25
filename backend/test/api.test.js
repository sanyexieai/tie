import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-backend-test-'))
process.env.TIE_DATA_DIR = dataDir
process.env.TIE_JWT_SECRET = 'tie-test-secret-for-ci-with-enough-length'
process.env.TIE_ALLOW_WEAK_SECRET = '1'

const { createApp } = await import('../src/app.js')

function demoPage(id, updatedAt, workspaceId) {
  return {
    id,
    title: '测试页面',
    icon: '📝',
    markdown: '# 测试页面\n\n正文',
    tags: ['测试'],
    parentId: null,
    sortKey: 0,
    createdAt: updatedAt,
    updatedAt,
    deletedAt: null,
    storageSourceId: `backend:${workspaceId}`,
  }
}

describe('tie backend api', { concurrency: 1 }, () => {
  /** @type {import('node:http').Server | null} */
  let server = null
  /** @type {string} */
  let baseUrl = ''
  /** @type {string} */
  let token = ''
  /** @type {string} */
  let workspaceId = ''
  const pageId = 'pg_test_api'

  before(async () => {
    server = createApp({ jwtSecret: process.env.TIE_JWT_SECRET }).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('无法启动测试服务器')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    await new Promise((resolve, reject) => server?.close((error) => error ? reject(error) : resolve(undefined)))
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  async function request(pathname, options = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, options)
    const contentType = response.headers.get('content-type') ?? ''
    const body = contentType.includes('application/json')
      ? await response.json()
      : Buffer.from(await response.arrayBuffer())
    return { response, body }
  }

  it('returns health status', async () => {
    const { response, body } = await request('/health')
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.service, 'tie-backend')
    assert.equal(body.mcp.enabled, false)
    assert.equal(body.mcp.running, false)
    assert.equal(body.mcp.url, null)
  })

  it('registers, logs in, and reads profile', async () => {
    const register = await request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'tester@example.com', password: 'secret123', name: 'Tester' }),
    })
    assert.equal(register.response.status, 200)
    assert.match(register.body.accessToken, /^[\w-]+\.[\w-]+\.[\w-]+$/)
    token = register.body.accessToken

    const me = await request('/api/v1/me', {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(me.response.status, 200)
    assert.equal(me.body.email, 'tester@example.com')

    const owned = await request('/api/v1/workspaces', {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(owned.response.status, 200)
    assert.equal(owned.body.length, 1)
    assert.equal(owned.body[0].name, '我的工作区')
    assert.equal(owned.body[0].default, true)
    assert.equal(owned.body[0].storageProviderId, undefined)

    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'tester@example.com', password: 'secret123' }),
    })
    assert.equal(login.response.status, 200)
    assert.ok(login.body.accessToken)

    const byName = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'Tester', password: 'secret123' }),
    })
    assert.equal(byName.response.status, 200)
    assert.equal(byName.body.user.email, 'tester@example.com')
  })

  it('rotates the refresh token and rejects the previous one', async () => {
    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'tester@example.com', password: 'secret123' }),
    })
    assert.equal(login.response.status, 200)
    assert.equal(typeof login.body.refreshToken, 'string')
    assert.notEqual(login.body.refreshToken, login.body.accessToken)

    const rotated = await request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: login.body.refreshToken }),
    })
    assert.equal(rotated.response.status, 200)
    assert.notEqual(rotated.body.refreshToken, login.body.refreshToken)
    assert.notEqual(rotated.body.accessToken, login.body.accessToken)

    const me = await request('/api/v1/me', {
      headers: { authorization: `Bearer ${rotated.body.accessToken}` },
    })
    assert.equal(me.response.status, 200)
    assert.equal(me.body.email, 'tester@example.com')

    const again = await request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: login.body.refreshToken }),
    })
    assert.equal(again.response.status, 401)

    const loggedOut = await request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: rotated.body.refreshToken }),
    })
    assert.equal(loggedOut.response.status, 204)
    const afterLogout = await request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: rotated.body.refreshToken }),
    })
    assert.equal(afterLogout.response.status, 401)
  })

  it('rejects unauthorized workspace access', async () => {
    const { response, body } = await request('/api/v1/workspaces')
    assert.equal(response.status, 401)
    assert.equal(body.message, '未登录')
  })

  it('creates workspace pages with optimistic locking and assets', async () => {
    const workspace = await request('/api/v1/workspaces', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: '测试工作区' }),
    })
    assert.equal(workspace.response.status, 201)
    workspaceId = workspace.body.id

    const stamp = '2026-08-28T08:00:00.000Z'
    const saved = await request(`/api/v1/workspaces/${workspaceId}/pages/${pageId}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(demoPage(pageId, stamp, workspaceId)),
    })
    assert.equal(saved.response.status, 200)
    assert.equal(saved.body.updatedAt, stamp)
    const workspaceDir = path.join(dataDir, 'workspaces', workspaceId)
    assert.equal(fs.existsSync(path.join(workspaceDir, 'pages', '测试页面.md')), true)
    assert.equal(fs.existsSync(path.join(workspaceDir, 'pages', `${pageId}.md`)), false)
    const meta = fs.readFileSync(path.join(workspaceDir, '.tie', 'meta', pageId), 'utf8')
    assert.match(meta, /file: pages\/测试页面\.md/)
    const tieName = fs.readdirSync(workspaceDir, { withFileTypes: true })
      .find((entry) => entry.isFile() && entry.name.endsWith('.tie'))
      ?.name
    assert.equal(tieName, '测试页面.tie')
    assert.match(fs.readFileSync(path.join(workspaceDir, tieName), 'utf8'), new RegExp(`root_page: ${pageId}`))

    const loaded = await request(`/api/v1/workspaces/${workspaceId}/pages/${pageId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(loaded.response.status, 200)
    assert.equal(loaded.body.markdown, '# 测试页面\n\n正文')

    const conflict = await request(`/api/v1/workspaces/${workspaceId}/pages/${pageId}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'if-unmodified-since': '2026-01-01T00:00:00.000Z',
      },
      body: JSON.stringify({ ...demoPage(pageId, '2026-08-28T09:00:00.000Z', workspaceId), markdown: '# stale\n\n' }),
    })
    assert.equal(conflict.response.status, 409)
    assert.match(conflict.body.message, /其他设备更新/)

    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    const uploaded = await request(`/api/v1/workspaces/${workspaceId}/pages/${pageId}/assets/a1.png`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
      },
      body: png,
    })
    assert.equal(uploaded.response.status, 201)
    assert.equal(uploaded.body.assetName, 'a1.png')

    const asset = await request(`/api/v1/workspaces/${workspaceId}/pages/${pageId}/assets/a1.png`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(asset.response.status, 200)
    assert.ok(Buffer.isBuffer(asset.body))
    assert.equal(asset.body.compare(png), 0)

    const listed = await request(`/api/v1/workspaces/${workspaceId}/pages/${pageId}/assets`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(listed.response.status, 200)
    assert.deepEqual(listed.body.assets, ['a1.png'])
  })

  it('rejects invalid resource ids before page, asset, or batch deletion access', async () => {
    const invalidId = encodeURIComponent('invalid/page')
    for (const suffix of ['', '/assets', '/assets/a1.png', '/revisions']) {
      const result = await request(`/api/v1/workspaces/${workspaceId}/pages/${invalidId}${suffix}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(result.response.status, 400)
    }
    const revision = await request(`/api/v1/workspaces/${workspaceId}/pages/${pageId}/revisions/${invalidId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(revision.response.status, 400)
    const removed = await request(`/api/v1/workspaces/${workspaceId}/pages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pageIds: [pageId, 'invalid/page'] }),
    })
    assert.equal(removed.response.status, 400)
    const retained = await request(`/api/v1/workspaces/${workspaceId}/pages/${pageId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(retained.response.status, 200)
  })

  it('stores workspace file registry and copy blobs', async () => {
    const fileId = 'file_aabbccddeeff0011'
    const meta = await request(`/api/v1/workspaces/${workspaceId}/files/${fileId}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: fileId,
        title: '手册',
        kind: 'file',
        mode: 'copy',
        ext: 'pdf',
        mime: 'application/pdf',
        size: 4,
        sourcePath: '/tmp/a.pdf',
        storedPath: `.tie/files/${fileId}/original.pdf`,
      }),
    })
    assert.equal(meta.response.status, 200)
    assert.equal(meta.body.id, fileId)

    const uploaded = await request(`/api/v1/workspaces/${workspaceId}/files/${fileId}/blob/original.pdf`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
      },
      body: Buffer.from('%PDF'),
    })
    assert.equal(uploaded.response.status, 201)

    const listed = await request(`/api/v1/workspaces/${workspaceId}/files`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(listed.response.status, 200)
    assert.equal(listed.body.files[0].id, fileId)
    assert.equal(listed.body.files[0].exists, true)

    const blob = await request(`/api/v1/workspaces/${workspaceId}/files/${fileId}/blob`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(blob.response.status, 200)
    assert.equal(Buffer.from(blob.body).toString(), '%PDF')
  })

  it('asks for email when several accounts share a username', async () => {
    for (const email of ['one@example.com', 'two@example.com']) {
      const created = await request('/api/v1/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'secret123', name: '同名' }),
      })
      assert.equal(created.response.status, 200)
    }
    const ambiguous = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '同名', password: 'secret123' }),
    })
    assert.equal(ambiguous.response.status, 401)
    assert.equal(ambiguous.body.message, '有多个同名账号，请用邮箱登录')
    const byEmail = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'one@example.com', password: 'secret123' }),
    })
    assert.equal(byEmail.response.status, 200)
  })
})
