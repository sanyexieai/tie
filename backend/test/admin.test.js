import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-backend-admin-'))
process.env.TIE_DATA_DIR = dataDir
process.env.TIE_JWT_SECRET = 'tie-test-secret-for-ci-with-enough-length'
process.env.TIE_ALLOW_WEAK_SECRET = '1'

const { createApp } = await import('../src/app.js')

function demoPage(id, updatedAt, workspaceId) {
  return {
    id,
    title: '租户页面',
    icon: '',
    markdown: '# 租户页面\n\n正文',
    tags: ['租户'],
    parentId: null,
    sortKey: 0,
    createdAt: updatedAt,
    updatedAt,
    deletedAt: null,
    storageSourceId: `backend:${workspaceId}`,
  }
}

describe('tie backend admin', { concurrency: 1 }, () => {
  /** @type {import('node:http').Server | null} */
  let server = null
  /** @type {string} */
  let baseUrl = ''
  /** @type {string} */
  let adminToken = ''

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
    const text = await response.text()
    const contentType = response.headers.get('content-type') ?? ''
    const body = contentType.includes('application/json') && text ? JSON.parse(text) : text
    return { response, body }
  }

  function adminHeaders(extra = {}) {
    return { authorization: `Bearer ${adminToken}`, ...extra }
  }

  it('serves the admin console', async () => {
    const page = await request('/admin/')
    assert.equal(page.response.status, 200)
    assert.match(page.body, /Tie 管理后台/)
  })

  it('lets the first registered user manage users and tenant data', async () => {
    const login = await request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'admin-pass-123', name: '运营' }),
    })
    assert.equal(login.response.status, 200)
    assert.equal(login.body.user.role, 'admin')
    adminToken = login.body.accessToken

    const denied = await request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.com', password: 'secret123', name: '成员' }),
    })
    assert.equal(denied.response.status, 200)
    assert.equal(denied.body.user.role, 'user')
    const memberToken = denied.body.accessToken
    const forbidden = await request('/api/v1/admin/overview', {
      headers: { authorization: `Bearer ${memberToken}` },
    })
    assert.equal(forbidden.response.status, 403)

    const workspace = await request('/api/v1/workspaces', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: '成员工作区' }),
    })
    assert.equal(workspace.response.status, 201)
    const workspaceId = workspace.body.id
    const pageId = 'pg_admin_data'
    const saved = await request(`/api/v1/workspaces/${workspaceId}/pages/${pageId}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(demoPage(pageId, '2026-08-28T08:00:00.000Z', workspaceId)),
    })
    assert.equal(saved.response.status, 200)

    const overview = await request('/api/v1/admin/overview', { headers: adminHeaders() })
    assert.equal(overview.response.status, 200)
    assert.equal(overview.body.users, 2)
    assert.equal(overview.body.workspaces, 3)
    assert.equal(overview.body.pages, 1)

    const listed = await request('/api/v1/admin/workspaces', { headers: adminHeaders() })
    const withPage = listed.body.find((item) => item.id === workspaceId)
    assert.equal(withPage.ownerEmail, 'member@example.com')
    assert.equal(withPage.pageCount, 1)

    const detail = await request(`/api/v1/admin/workspaces/${workspaceId}`, { headers: adminHeaders() })
    assert.equal(detail.body.pages[0].title, '租户页面')
    assert.equal(detail.body.activePageCount, 1)
    assert.equal(detail.body.ownerId, denied.body.user.id)
    assert.equal(path.resolve(detail.body.serverPath), path.resolve(dataDir, 'workspaces', workspaceId))

    const reading = await request(`/api/v1/admin/workspaces/${workspaceId}/pages/${pageId}`, { headers: adminHeaders() })
    assert.equal(reading.response.status, 200)
    assert.equal(reading.body.markdown, '# 租户页面\n\n正文')

    const memberProfile = await request(`/api/v1/admin/users/${denied.body.user.id}`, { headers: adminHeaders() })
    assert.equal(memberProfile.response.status, 200)
    assert.equal(memberProfile.body.workspaces.length, 2)

    const trashed = await request(`/api/v1/workspaces/${workspaceId}/pages/${pageId}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${memberToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...demoPage(pageId, '2026-08-28T08:00:00.000Z', workspaceId), deletedAt: '2026-08-28T09:00:00.000Z' }),
    })
    assert.equal(trashed.response.status, 200)
    const restored = await request(`/api/v1/admin/workspaces/${workspaceId}/pages/${pageId}/restore`, {
      method: 'POST',
      headers: adminHeaders(),
    })
    assert.equal(restored.response.status, 200)
    assert.equal(restored.body.deletedAt, null)

    const transferred = await request(`/api/v1/admin/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ ownerId: login.body.user.id }),
    })
    assert.equal(transferred.response.status, 200)
    assert.equal(transferred.body.ownerEmail, 'admin@example.com')

    const createdWorkspace = await request('/api/v1/admin/workspaces', {
      method: 'POST',
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: '代建工作区', ownerId: denied.body.user.id }),
    })
    assert.equal(createdWorkspace.response.status, 201)
    assert.equal(createdWorkspace.body.ownerEmail, 'member@example.com')

    const removedPage = await request(`/api/v1/admin/workspaces/${workspaceId}/pages/${pageId}`, {
      method: 'DELETE',
      headers: adminHeaders(),
    })
    assert.equal(removedPage.response.status, 204)

    const renamed = await request(`/api/v1/admin/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: '已改名' }),
    })
    assert.equal(renamed.response.status, 200)
    assert.equal(renamed.body.name, '已改名')

    const created = await request('/api/v1/admin/users', {
      method: 'POST',
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', password: 'secret123', name: '新用户', role: 'user' }),
    })
    assert.equal(created.response.status, 201)
    const disabled = await request(`/api/v1/admin/users/${created.body.id}`, {
      method: 'PATCH',
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    })
    assert.equal(disabled.response.status, 200)
    const blocked = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', password: 'secret123' }),
    })
    assert.equal(blocked.response.status, 403)

    const selfDelete = await request(`/api/v1/admin/users/${login.body.user.id}`, {
      method: 'DELETE',
      headers: adminHeaders(),
    })
    assert.equal(selfDelete.response.status, 409)

    const removedUser = await request(`/api/v1/admin/users/${denied.body.user.id}`, {
      method: 'DELETE',
      headers: adminHeaders(),
    })
    assert.equal(removedUser.response.status, 204)
    const after = await request('/api/v1/admin/workspaces', { headers: adminHeaders() })
    assert.equal(after.body.length, 2)
    const renamedWorkspace = after.body.find((item) => item.name === '已改名')
    assert.equal(renamedWorkspace.ownerEmail, 'admin@example.com')
  })
})
