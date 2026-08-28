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

    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'tester@example.com', password: 'secret123' }),
    })
    assert.equal(login.response.status, 200)
    assert.ok(login.body.accessToken)
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
})
