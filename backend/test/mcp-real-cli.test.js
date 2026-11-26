import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('native HTTP MCP uses the real Rust CLI for changes and shared signals', { skip: !process.env.TIE_TEST_CLI }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-http-real-cli-'))
  process.env.TIE_DATA_DIR = dataDir
  process.env.TIE_APP_DATA = path.join(dataDir, 'app-data')
  process.env.TIE_ALLOW_WEAK_SECRET = '1'
  const { createApp } = await import('../src/app.js')
  const { closeLive } = await import('../src/live.js')
  const server = createApp({ jwtSecret: 'real-cli-http-test-secret-123456789' }).listen(0, '127.0.0.1')
  try {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const endpoint = `http://127.0.0.1:${server.address().port}`
    let token
    const origin = { clientId: 'http-test-agent', clientName: '纯 HTTP Agent', clientVersion: 'test',
      deviceId: 'dev_http_client', deviceName: '调用端电脑', platform: 'windows', actor: '测试 Agent' }
    async function request(route, body, method = 'POST') {
      const response = await fetch(`${endpoint}${route}`, { method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-tie-origin': encodeURIComponent(JSON.stringify(origin)) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const result = await response.json()
      assert.ok(response.ok, JSON.stringify(result))
      return result
    }
    const account = await request('/api/v1/auth/register', { name: 'HTTP测试', email: 'http-cli@example.test', password: 'testing123' })
    token = account.accessToken
    await request('/api/v1/admin/settings', { mcp: { enabled: true, cliPath: path.resolve(process.env.TIE_TEST_CLI) } }, 'PUT')
    const workspace = await request('/api/v1/workspaces', { name: 'HTTP测试库' })
    const issued = await request('/api/v1/me/mcp-tokens', { name: 'HTTP专用Agent', workspaceId: workspace.id })
    token = issued.token
    async function call(name, args) {
      const result = await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      assert.notEqual(result.result?.isError, true, JSON.stringify(result))
      return JSON.parse(result.result.content[0].text)
    }
    const tools = await request('/mcp', { jsonrpc: '2.0', id: 0, method: 'tools/list' })
    for (const name of ['tie_changes', 'tie_signal_list', 'tie_signal_add', 'tie_signal_resolve']) assert.ok(tools.result.tools.some((tool) => tool.name === name))
    const written = await call('tie_write', { title: 'HTTP讨论', markdown: '第一版正文' })
    const page = written.page || written
    assert.ok(page.id, JSON.stringify(written))
    let changes = await call('tie_changes', { id_or_title: page.id })
    assert.equal(changes.entries.length, 1)
    assert.equal(changes.entries[0].origin.deviceId, origin.deviceId)
    assert.equal(changes.entries[0].origin.clientName, origin.clientName)
    assert.equal(changes.entries[0].origin.userId, account.user.id)
    await call('tie_signal_add', { id_or_title: page.id, id: 'op_http', opinionKind: 'correction', body: '改成第二版', baseUpdatedAt: page.updatedAt })
    const updated = await call('tie_write', { pageId: page.id, markdown: '第二版正文' })
    const saved = updated.page || updated
    await call('tie_signal_resolve', { id_or_title: page.id, id: 'op_http', status: 'adopted', appliedUpdatedAt: saved.updatedAt })
    let signals = await call('tie_signal_list', { id_or_title: page.id })
    assert.equal(signals.entries[0].status, 'adopted')
    assert.equal(signals.entries[0].resolutionOrigin.deviceId, origin.deviceId)
    await call('tie_signal_resolve', { id_or_title: page.id, id: 'op_http', status: 'withdrawn' })
    signals = await call('tie_signal_list', { id_or_title: page.id })
    assert.equal(signals.entries[0].status, 'withdrawn')
    changes = await call('tie_changes', { id_or_title: page.id })
    assert.equal(changes.entries.length, 2)
    assert.equal(fs.existsSync(path.join(dataDir, 'app-data/device.json')), false, 'HTTP server must not invent a caller device')
  } finally {
    closeLive()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
