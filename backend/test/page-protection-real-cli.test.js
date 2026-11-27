import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { decryptMarkdown, encryptMarkdown, importEncryptionPassword, isEncryptedMarkdown } from '../../src/services/encrypted-markdown.ts'

const PASSWORD = '  fixture-http-page-password  '
function assertPrivate(dir, canaries) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name)
    if (entry.isDirectory()) assertPrivate(name, canaries)
    else {
      const text = fs.readFileSync(name).toString('utf8')
      for (const canary of canaries) assert.ok(!text.includes(canary), `${name} contains ${canary}`)
    }
  }
}

test('pure HTTP MCP protects all page operations per call and REST converts the real client bundle without a password upload', { skip: !process.env.TIE_TEST_CLI }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-protection-real-cli-'))
  process.env.TIE_DATA_DIR = dataDir
  process.env.TIE_APP_DATA = path.join(dataDir, 'app-data')
  process.env.TIE_ALLOW_WEAK_SECRET = '1'
  const { createApp } = await import('../src/app.js')
  const { closeLive } = await import('../src/live.js')
  const { store } = await import('../src/store.js')
  const server = createApp({ jwtSecret: 'page-protection-real-cli-secret-12345' }).listen(0, '127.0.0.1')
  try {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const endpoint = `http://127.0.0.1:${server.address().port}`
    let token
    async function request(route, body, method = 'POST', expectedStatus) {
      const response = await fetch(`${endpoint}${route}`, { method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const result = await response.json()
      if (expectedStatus) assert.equal(response.status, expectedStatus, JSON.stringify(result))
      else assert.ok(response.ok, JSON.stringify(result))
      return result
    }
    const account = await request('/api/v1/auth/register', { name: 'ProtectionTest', email: 'page-protection@example.test', password: 'testing123' })
    token = account.accessToken
    await request('/api/v1/admin/settings', { mcp: { enabled: true, cliPath: path.resolve(process.env.TIE_TEST_CLI) } }, 'PUT')
    const workspace = await request('/api/v1/workspaces', { name: 'ProtectionTest' })
    const first = await request('/api/v1/me/mcp-tokens', { name: 'FirstAgent', workspaceId: workspace.id })
    const second = await request('/api/v1/me/mcp-tokens', { name: 'SecondAgent', workspaceId: workspace.id })
    token = first.token
    async function tool(name, args, rejected = false) {
      const response = await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      assert.equal(response.result?.isError, rejected, JSON.stringify(response))
      return rejected ? response.result : JSON.parse(response.result.content[0].text)
    }
    const tools = await request('/mcp', { jsonrpc: '2.0', id: 0, method: 'tools/list' })
    assert.ok(tools.result.tools.some((tool) => tool.name === 'tie_page_protection'))
    assert.ok(!tools.result.tools.some((tool) => tool.name.startsWith('tie_internal_protection')))
    const created = await tool('tie_write', { title: 'HTTPProtected', markdown: 'fixture-http-private-original-8304', encrypted: true, password: PASSWORD })
    const id = created.page.id
    assert.equal((await tool('tie_get', { id_or_title: id })).locked, true)
    assert.ok((await tool('tie_get', { id_or_title: id, password: PASSWORD })).markdown.includes('fixture-http-private-original-8304'))
    token = second.token
    assert.equal((await tool('tie_get', { id_or_title: id })).locked, true, 'another token never inherits an unlock')
    await tool('tie_get', { id_or_title: id, password: 'wrong' }, true)
    assert.equal((await tool('tie_search', { query: 'fixture-http-private-original-8304' })).results.length, 0)
    assert.equal((await tool('tie_search', { query: 'fixture-http-private-original-8304', password: PASSWORD })).results[0].id, id)
    const edited = await tool('tie_write', { pageId: id, markdown: 'fixture-http-private-edited-8304', password: PASSWORD })
    await tool('tie_signal_add', { id_or_title: id, id: 'op_http', opinionKind: 'correction', body: 'fixture-http-private-opinion-8304', quote: 'fixture-http-private-quote-8304', baseUpdatedAt: edited.page.updatedAt, password: PASSWORD })
    await tool('tie_signal_add', { id_or_title: id, id: 'op_reply', opinionKind: 'support', body: 'fixture-http-private-reply-8304', replyTo: 'op_http', baseUpdatedAt: edited.page.updatedAt, password: PASSWORD })
    await tool('tie_signal_resolve', { id_or_title: id, id: 'op_http', status: 'resolved', resolutionNote: 'fixture-http-private-note-8304', password: PASSWORD })
    const opinions = await tool('tie_signal_list', { id_or_title: id, password: PASSWORD })
    assert.ok(opinions.entries.some((entry) => entry.body === 'fixture-http-private-opinion-8304' && entry.resolutionNote === 'fixture-http-private-note-8304'))
    const revision = (await tool('tie_history', { id_or_title: id }))[0].id
    assert.equal((await tool('tie_revision_get', { id_or_title: id, revisionId: revision })).locked, true)
    assert.ok((await tool('tie_diff', { id_or_title: id, revisionId: revision, password: PASSWORD })).diff.includes('fixture-http-private-original-8304'))
    await tool('tie_restore', { id_or_title: id, revisionId: revision, expectedUpdatedAt: edited.page.updatedAt, password: PASSWORD })
    await tool('tie_internal_protection_read', { id_or_title: id }, true)
    await tool('tie_internal_protection_replace', { bundle: {} }, true)
    assertPrivate(store.workspaceDir(workspace.id), ['fixture-http-private-', PASSWORD])
    await tool('tie_page_protection', { id_or_title: id, action: 'convert', encrypted: false, password: 'wrong' }, true)
    await tool('tie_page_protection', { id_or_title: id, action: 'convert', encrypted: false, password: PASSWORD })
    assert.equal((await tool('tie_get', { id_or_title: id })).encrypted, false)
    await tool('tie_page_protection', { id_or_title: id, action: 'convert', encrypted: true, password: PASSWORD })
    assertPrivate(store.workspaceDir(workspace.id), ['fixture-http-private-', PASSWORD])

    const ordinary = await tool('tie_write', { title: 'ClientConversion', markdown: 'fixture-client-private-old-1596' })
    const plainId = ordinary.page.id
    await tool('tie_write', { pageId: plainId, markdown: 'fixture-client-private-current-1596' })
    const base = `/api/v1/workspaces/${workspace.id}/pages/${plainId}`
    await request(`${base}/protection`, undefined, 'GET', 401)
    token = account.accessToken
    await request(`/api/v1/workspaces/${workspace.id}/pages/pg_not_synced/protection`, undefined, 'GET', 404)
    let bundle = await request(`${base}/protection`, undefined, 'GET')
    const key = await importEncryptionPassword(PASSWORD)
    const source = structuredClone(bundle)
    bundle.page.markdown = await encryptMarkdown(bundle.page.markdown, key)
    for (const revision of bundle.revisions) revision.page.markdown = await encryptMarkdown(revision.page.markdown, key)
    const rawPut = await request(base, { ...bundle.page }, 'PUT', 409)
    assert.match(rawPut.message, /保护|转换/)
    const saved = await request(`${base}/protection`, { bundle, expectedUpdatedAt: source.page.updatedAt }, 'PUT')
    assert.equal(saved.id, plainId)
    assert.ok(isEncryptedMarkdown(saved.markdown))
    await request(`${base}/protection`, { bundle, expectedUpdatedAt: source.page.updatedAt }, 'PUT', 409)
    assertPrivate(store.workspaceDir(workspace.id), ['fixture-client-private-', 'fixture-http-private-', PASSWORD])
    bundle = await request(`${base}/protection`, undefined, 'GET')
    bundle.page.markdown = await decryptMarkdown(bundle.page.markdown, key)
    for (const revision of bundle.revisions) revision.page.markdown = await decryptMarkdown(revision.page.markdown, key)
    const plain = await request(`${base}/protection`, { bundle, expectedUpdatedAt: bundle.page.updatedAt }, 'PUT')
    assert.equal(plain.markdown, source.page.markdown)
    assert.equal(plain.id, source.page.id)
    assert.equal(plain.tags.join(','), source.page.tags.join(','))
  } finally {
    closeLive()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
