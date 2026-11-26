import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-backend-mcp-tokens-'))
process.env.TIE_DATA_DIR = dataDir
process.env.NODE_ENV = 'test'
const serverSecret = 'test-only-persistent-mcp-token-secret-123456'
const { createApp } = await import('../src/app.js')
const { store } = await import('../src/store.js')
const { findMcpToken, hashMcpToken } = await import('../src/mcp-tokens.js')

describe('owner-managed MCP tokens', { concurrency: 1 }, () => {
  let server
  let base
  let admin
  let owner
  let other
  let workspaceId

  async function startServer() {
    server = createApp({ jwtSecret: serverSecret }).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  }

  async function request(route, { session, method = 'GET', body } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null }
  }

  async function register(name) {
    const result = await request('/api/v1/auth/register', {
      method: 'POST', body: { email: `${name}@example.test`, name, password: 'fixture-password-123' },
    })
    assert.equal(result.status, 200)
    return result.body
  }

  function issue(body = {}) {
    return request('/api/v1/me/mcp-tokens', {
      session: owner, method: 'POST', body: { name: 'Fixture Agent', workspaceId, ...body },
    })
  }

  before(async () => {
    await startServer()
    admin = await register('token-admin')
    owner = await register('token-owner')
    other = await register('token-other')
    const workspaces = await request('/api/v1/workspaces', { session: owner })
    workspaceId = workspaces.body[0].id
  })

  after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('reveals a new token after reopening the app with the same server secret, but lists only metadata', async () => {
    const issued = await issue()
    assert.equal(issued.status, 201)
    assert.equal(issued.headers.get('cache-control'), 'no-store')
    assert.match(issued.body.token, /^tmcp_/)
    assert.equal(issued.body.record.canReveal, true)
    const { token, record } = issued.body
    const stored = store.loadMcpTokens().find((item) => item.id === record.id)
    assert.equal(stored.tokenHash, hashMcpToken(token))
    assert.equal(stored.encryptedToken.version, 1)
    assert.ok(!fs.readFileSync(path.join(dataDir, 'mcp-tokens.json'), 'utf8').includes(token))
    assert.equal(findMcpToken(token).id, record.id)

    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await startServer()
    const revealed = await request(`/api/v1/me/mcp-tokens/${record.id}/secret`, { session: owner })
    assert.equal(revealed.status, 200)
    assert.equal(revealed.headers.get('cache-control'), 'no-store')
    assert.deepEqual(revealed.body, { token })
    const listed = await request('/api/v1/me/mcp-tokens', { session: owner })
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.find((item) => item.id === record.id), record)
    for (const item of listed.body) {
      assert.deepEqual(Object.keys(item).sort(), ['canReveal', 'createdAt', 'id', 'lastUsedAt', 'name', 'workspaceId'])
    }
    assert.ok(!JSON.stringify(listed.body).includes(token))
    assert.ok(!JSON.stringify(listed.body).includes(stored.tokenHash))
    assert.ok(!JSON.stringify(listed.body).includes(stored.encryptedToken.ciphertext))
  })

  it('issues a maintainable token without exposing it when reveal is false', async () => {
    const issued = await issue({ reveal: false })
    assert.equal(issued.status, 201)
    assert.equal(issued.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Object.keys(issued.body), ['record'])
    assert.equal(issued.body.record.canReveal, true)
    const revealed = await request(`/api/v1/me/mcp-tokens/${issued.body.record.id}/secret`, { session: owner })
    assert.equal(revealed.status, 200)
    assert.equal(findMcpToken(revealed.body.token).id, issued.body.record.id)
  })

  it('keeps legacy hash-only tokens valid and unchanged, while explaining why they cannot be revealed', async () => {
    const token = 'tmcp_legacy_token_fixture_only'
    const legacy = {
      id: 'mtok_legacy_fixture', userId: owner.user.id, name: 'Legacy Agent', workspaceId,
      tokenHash: hashMcpToken(token), createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null,
    }
    store.saveMcpTokens([...store.loadMcpTokens(), legacy])
    const result = await request(`/api/v1/me/mcp-tokens/${legacy.id}/secret`, { session: owner })
    assert.equal(result.status, 409)
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.match(result.body.message, /旧令牌.*无法查看.*重新签发.*原令牌仍可继续使用/)
    assert.equal(result.body.token, undefined)
    assert.deepEqual(findMcpToken(token), legacy)
    assert.deepEqual(store.loadMcpTokens().find((item) => item.id === legacy.id), legacy)
    const listed = await request('/api/v1/me/mcp-tokens', { session: owner })
    assert.equal(listed.body.find((item) => item.id === legacy.id).canReveal, false)
  })

  it('requires owner authentication even for an administrator, and keeps foreign tokens out of lists', async () => {
    const issued = await issue()
    const url = `/api/v1/me/mcp-tokens/${issued.body.record.id}`
    const anonymous = await request(url + '/secret')
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.headers.get('cache-control'), 'no-store')
    for (const session of [admin, other]) {
      assert.equal((await request(url + '/secret', { session })).status, 404)
      assert.equal((await request(url, { session, method: 'DELETE' })).status, 404)
      const listed = await request('/api/v1/me/mcp-tokens', { session })
      assert.ok(!listed.body.some((item) => item.id === issued.body.record.id))
      const foreignIssue = await request('/api/v1/me/mcp-tokens', {
        session, method: 'POST', body: { workspaceId, reveal: false },
      })
      assert.equal(foreignIssue.status, 404)
    }
    assert.equal((await request(url + '/secret', { session: owner })).status, 200)
  })

  it('prevents revealing, using, or listing a revoked token', async () => {
    const issued = await issue()
    const url = `/api/v1/me/mcp-tokens/${issued.body.record.id}`
    assert.equal((await request(url, { session: owner, method: 'DELETE' })).status, 204)
    assert.equal((await request(url + '/secret', { session: owner })).status, 404)
    assert.equal(findMcpToken(issued.body.token), null)
    const listed = await request('/api/v1/me/mcp-tokens', { session: owner })
    assert.ok(!listed.body.some((item) => item.id === issued.body.record.id))
  })

  it('rejects disabled account sessions before token maintenance or reveal', async () => {
    const issued = await issue()
    const url = `/api/v1/me/mcp-tokens/${issued.body.record.id}`
    const disabled = await request(`/api/v1/admin/users/${owner.user.id}`, {
      session: admin, method: 'PATCH', body: { disabled: true },
    })
    assert.equal(disabled.status, 200)
    try {
      for (const route of [url + '/secret', '/api/v1/me/mcp-tokens']) {
        assert.equal((await request(route, { session: owner })).status, 403)
      }
      assert.equal((await issue({ reveal: false })).status, 403)
      assert.equal((await request(url, { session: owner, method: 'DELETE' })).status, 403)
      assert.equal((await request(url + '/secret', { session: admin })).status, 404)
    } finally {
      const restored = await request(`/api/v1/admin/users/${owner.user.id}`, {
        session: admin, method: 'PATCH', body: { disabled: false },
      })
      assert.equal(restored.status, 200)
    }
  })

  it('binds the encrypted secret to its token record without changing hash authentication', async () => {
    const first = await issue()
    const second = await issue()
    const tokens = store.loadMcpTokens()
    const source = tokens.find((item) => item.id === first.body.record.id)
    const target = tokens.find((item) => item.id === second.body.record.id)
    target.encryptedToken = source.encryptedToken
    store.saveMcpTokens(tokens)
    const result = await request(`/api/v1/me/mcp-tokens/${target.id}/secret`, { session: owner })
    assert.equal(result.status, 409)
    assert.equal(result.body.token, undefined)
    assert.equal(findMcpToken(second.body.token).id, target.id)
  })

  it('rejects a non-boolean reveal flag without creating a token', async () => {
    const beforeCount = store.loadMcpTokens().length
    assert.equal((await issue({ reveal: 'false' })).status, 400)
    assert.equal(store.loadMcpTokens().length, beforeCount)
  })
})
