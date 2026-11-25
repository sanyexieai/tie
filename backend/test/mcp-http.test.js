import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-backend-mcp-'))
process.env.TIE_DATA_DIR = dataDir
process.env.TIE_JWT_SECRET = 'tie-test-secret-for-ci-with-enough-length'
process.env.TIE_ALLOW_WEAK_SECRET = '1'

const { createApp } = await import('../src/app.js')
const cliPath = path.join(dataDir, process.platform === 'win32' ? 'tie-cli.cmd' : 'tie-cli')

describe('mcp http from settings', { concurrency: 1 }, () => {
  /** @type {import('node:http').Server | null} */
  let server = null
  /** @type {string} */
  let baseUrl = ''
  /** @type {string} */
  let adminToken = ''
  /** @type {string} */
  let userToken = ''

  before(async () => {
    const fake = path.join(dataDir, 'fake-mcp.cjs')
    fs.writeFileSync(fake, [
      "let raw = ''",
      "process.stdin.on('data', (chunk) => { raw += chunk })",
      "process.stdin.on('end', () => {",
      '  const message = JSON.parse(raw)',
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true, method: message.method } }) + '\\n')",
      '})',
      '',
    ].join('\n'))
    fs.writeFileSync(cliPath, process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`
      : `#!${process.execPath}\n${fs.readFileSync(fake, 'utf8')}`)
    fs.chmodSync(cliPath, 0o755)
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

  it('keeps MCP off until an admin saves it, then a user token reaches tie-cli', async () => {
    const health = await request('/health')
    assert.equal(health.body.mcp.enabled, false)
    assert.equal(health.body.mcp.url, null)
    assert.equal(health.body.mcp.transport, 'tie-cli')

    const closed = await request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    })
    assert.equal(closed.response.status, 503)

    const admin = await request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'admin-pass-123', name: '运营' }),
    })
    adminToken = admin.body.accessToken
    const member = await request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.com', password: 'secret123', name: '成员' }),
    })
    userToken = member.body.accessToken

    const denied = await request('/api/v1/admin/settings', { headers: { authorization: `Bearer ${userToken}` } })
    assert.equal(denied.response.status, 403)

    const saved = await request('/api/v1/admin/settings', {
      method: 'PUT',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        mcp: { enabled: true, cliPath },
        ai: { apiKey: 'sk-test', baseUrl: 'https://example.test/v1', model: 'demo' },
      }),
    })
    assert.equal(saved.response.status, 200)
    assert.equal(saved.body.mcp.enabled, true)
    assert.equal(saved.body.mcp.cliOk, true)
    assert.equal(saved.body.ai.hasApiKey, true)
    assert.equal(saved.body.ai.apiKey, undefined)

    const mine = await request('/api/v1/workspaces', {
      method: 'POST',
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '成员的库' }),
    })
    assert.equal(mine.response.status, 201)
    const foreign = await request('/api/v1/me/mcp-tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '越权', workspaceId: 'ws_missing' }),
    })
    assert.equal(foreign.response.status, 404)

    const issued = await request('/api/v1/me/mcp-tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '我的 Agent', workspaceId: mine.body.id }),
    })
    assert.equal(issued.response.status, 201)
    assert.match(issued.body.token, /^tmcp_/)

    const page = await request('/me/')
    assert.equal(page.response.status, 200)
    assert.match(page.body, /我的账号/)

    const missing = await request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    assert.equal(missing.response.status, 401)

    const called = await request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.body.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    })
    assert.equal(called.response.status, 200)
    assert.equal(called.body.result.ok, true)
    assert.equal(called.body.result.method, 'tools/list')

    const sessionCall = await request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userToken}`,
        'x-tie-workspace': mine.body.id,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }),
    })
    assert.equal(sessionCall.response.status, 200)
    assert.equal(sessionCall.body.result.method, 'tools/list')

    const otherWorkspace = await request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${userToken}`,
        'x-tie-workspace': 'ws_missing',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
    })
    assert.equal(otherWorkspace.response.status, 404)
  })
})
