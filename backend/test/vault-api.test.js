import assert from 'node:assert/strict'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-vault-api-'))
const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const value = 'fixture-only-vault-value-not-a-real-credential'
let upstream, backend, base, endpoint, token, session, workspace, otherToken, secret
let upstreamCalls = 0

async function request(route, { body, bearer = session, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = response.status === 204 ? null : await response.json()
  return { response, payload }
}

async function call(name, args = {}, bearer = token, headers = {}) {
  const result = await request('/mcp', { bearer, headers, body: {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  } })
  assert.equal(result.response.status, 200)
  return { error: result.payload.result.isError, value: JSON.parse(result.payload.result.content[0].text) }
}

async function grant(principal, maxUses = 1, secretId = secret.id) {
  const result = await request(`/api/v1/me/secrets/${secretId}/grants`, { body: {
    principal, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), maxUses,
  } })
  assert.equal(result.response.status, 201, JSON.stringify(result.payload))
  return result.payload
}

describe('credential vault through owner REST and native HTTP MCP', { concurrency: 1 }, () => {
  before(async () => {
    upstream = https.createServer({ key: fs.readFileSync(fixture('vault-server-key.pem')), cert: fs.readFileSync(fixture('vault-server-cert.pem')) }, (req, res) => {
      upstreamCalls += 1
      assert.equal(req.headers.authorization, `Bearer ${value}`)
      assert.equal(req.method, 'POST')
      assert(['/fixed-action', '/failing-action'].includes(req.url))
      req.resume()
      res.writeHead(req.url === '/failing-action' ? 503 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ result: 'ready', nested: { ok: true }, safeEcho: `echo ${value}`, copy: Buffer.from(value).toString('base64') }))
    }).listen(0, '127.0.0.1')
    await new Promise(resolve => upstream.once('listening', resolve))
    endpoint = `https://127.0.0.1:${upstream.address().port}`
    const cli = path.join(temp, 'fake-cli.cjs')
    fs.writeFileSync(cli, `#!${process.execPath}\nlet text='';process.stdin.on('data',d=>text+=d);process.stdin.on('end',()=>{const m=JSON.parse(text);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='tools/list'?{tools:[{name:'tie_get'}]}:{isError:true,content:[{type:'text',text:'unsupported fixture tool'}]}})+'\\n')});`)
    fs.chmodSync(cli, 0o755)
    const script = `import {createApp} from ${JSON.stringify(new URL('../src/app.js', import.meta.url).href)};
      import {closeLive} from ${JSON.stringify(new URL('../src/live.js', import.meta.url).href)};
      const server=createApp().listen(0,'127.0.0.1',()=>process.send({base:'http://127.0.0.1:'+server.address().port}));
      process.on('message',()=>{closeLive();server.close(()=>process.exit(0));});`
    backend = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TIE_DATA_DIR: temp, TIE_JWT_SECRET: 'isolated-vault-api-fixture-secret-that-is-long-enough',
        TIE_VAULT_ALLOWED_ORIGINS: endpoint, TIE_VAULT_KEY_FILE: '', NODE_EXTRA_CA_CERTS: fixture('vault-ca.pem') },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = ''
    backend.stderr.on('data', chunk => { stderr += chunk.toString() })
    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture backend startup timeout')), 10_000)
      backend.once('message', data => { clearTimeout(timer); resolve(data.base) })
      backend.once('exit', () => { clearTimeout(timer); reject(new Error(`Fixture backend exited: ${stderr}`)) })
    })
    const registered = await request('/api/v1/auth/register', { bearer: '', body: { email: 'vault-owner@example.test', password: 'FixturePassword123', name: 'Vault owner' } })
    assert.equal(registered.response.status, 200)
    session = registered.payload.accessToken
    const workspaces = await request('/api/v1/workspaces')
    workspace = workspaces.payload[0].id
    const configured = await request('/api/v1/admin/settings', { method: 'PUT', body: { mcp: { enabled: true, cliPath: cli } } })
    assert.equal(configured.response.status, 200)
    const issued = await request('/api/v1/me/mcp-tokens', { body: { name: 'Vault Agent', workspaceId: workspace } })
    token = issued.payload.token
    otherToken = (await request('/api/v1/me/mcp-tokens', { body: { name: 'Other Agent', workspaceId: workspace } })).payload
  })

  after(async () => {
    if (backend?.exitCode === null) {
      const exited = new Promise(resolve => backend.once('exit', resolve))
      backend.send('stop')
      await exited
    }
    if (upstream) await new Promise(resolve => upstream.close(resolve))
    fs.rmSync(temp, { recursive: true, force: true })
  })

  it('stores encrypted values outside workspaces and reveals only through the owner endpoint', async () => {
    const created = await request('/api/v1/me/secrets', { body: {
      workspaceId: workspace, name: 'Production deploy', service: 'deploy', environment: 'production', tags: ['ops'],
      value, target: { url: endpoint + '/fixed-action', method: 'POST', authType: 'bearer', body: '{"operation":"check"}', responseFields: ['result', 'nested.ok', 'safeEcho', 'copy'] },
    } })
    assert.equal(created.response.status, 201, JSON.stringify(created.payload))
    secret = created.payload
    assert.equal(Object.hasOwn(secret, 'value'), false)
    assert.equal(Object.hasOwn(secret, 'target'), false)
    assert.equal(Object.hasOwn(secret, 'encryptedValue'), false)
    const disk = fs.readFileSync(path.join(temp, 'vault.json'), 'utf8')
    assert.equal(disk.includes(value), false)
    const listed = await call('tie_secret_search', { query: 'Production', service: 'deploy', environment: 'production' })
    assert.equal(listed.error, false)
    assert.equal(listed.value[0].secretRef, secret.secretRef)
    assert.equal(JSON.stringify(listed).includes(value), false)
    assert.deepEqual((await call('tie_secret_search', { query: value })).value, [])
    const reveal = await request(`/api/v1/me/secrets/${secret.id}/value`)
    assert.equal(reveal.payload.value, value)
    assert.equal(reveal.response.headers.get('cache-control'), 'no-store')
    assert.equal((await request(`/api/v1/me/secrets/${secret.id}/value`, { bearer: token })).response.status, 401)
  })

  it('manages storage-only credentials over REST while native HTTP MCP returns metadata and refuses execution', async () => {
    const storedValue = 'STORAGE_ONLY_FIXTURE_NOT_A_REAL_SECRET'
    const created = await request('/api/v1/me/secrets', { body: {
      workspaceId: workspace, name: 'Personal credential page', value: storedValue,
    } })
    assert.equal(created.response.status, 201)
    const stored = created.payload
    assert.equal(stored.action, null)
    assert.ok(!JSON.stringify(stored).includes(storedValue))
    const detail = await request(`/api/v1/me/secrets/${stored.id}`)
    assert.equal(detail.payload.target, null)
    const edited = await request(`/api/v1/me/secrets/${stored.id}`, { method: 'PUT', body: { description: 'A saved private value' } })
    assert.equal(edited.response.status, 200)
    const revealed = await request(`/api/v1/me/secrets/${stored.id}/value`)
    assert.equal(revealed.payload.value, storedValue)
    const search = await call('tie_secret_search', { query: stored.name })
    assert.equal(search.error, false)
    assert.equal(search.value.length, 1)
    assert.equal(search.value[0].action, null)
    assert.ok(!JSON.stringify(search.value).includes(storedValue))
    const refusedGrant = await request(`/api/v1/me/secrets/${stored.id}/grants`, { body: { principal: { type: 'session', id: 'current' } } })
    assert.equal(refusedGrant.response.status, 409)
    assert.equal(refusedGrant.payload.code, 'ACTION_REQUIRED')
    const callsBefore = upstreamCalls
    const refusedUse = await call('tie_secret_use', { secretRef: stored.secretRef })
    assert.equal(refusedUse.error, true)
    assert.equal(refusedUse.value.code, 'ACTION_REQUIRED')
    assert.equal(refusedUse.value.configurationRequired, true)
    assert.equal(upstreamCalls, callsBefore)
    assert.ok(!JSON.stringify(refusedUse).includes(storedValue))
    const usage = await call('tie_secret_usage', { secretRef: stored.secretRef })
    assert.equal(usage.value[0].reason, 'ACTION_REQUIRED')
    assert.equal(usage.value[0].status, 'denied')
    const deleted = await request(`/api/v1/me/secrets/${stored.id}`, { method: 'DELETE' })
    assert.equal(deleted.response.status, 204)
    assert.equal((await request(`/api/v1/me/secrets/${stored.id}`)).response.status, 404)
  })

  it('requires owner approval, binds grants to the caller and consumes one-time grants', async () => {
    const denied = await call('tie_secret_use', { secretRef: secret.secretRef })
    assert.equal(denied.error, true)
    assert.equal(denied.value.approvalRequired, true)
    const tokens = await request('/api/v1/me/mcp-tokens')
    const principal = { type: 'mcp-token', id: tokens.payload.find(item => item.name === 'Vault Agent').id }
    const approved = await grant(principal)
    const other = await call('tie_secret_use', { secretRef: secret.secretRef, grantId: approved.id }, otherToken.token)
    assert.equal(other.error, true)
    const used = await call('tie_secret_use', { secretRef: secret.secretRef })
    assert.equal(used.error, false, JSON.stringify(used.value))
    assert.equal(used.value.httpStatus, 200)
    assert.equal(used.value.fields.result, 'ready')
    assert.equal(JSON.stringify(used).includes(value), false)
    assert.equal(JSON.stringify(used).includes(Buffer.from(value).toString('base64')), false)
    assert.equal(upstreamCalls, 1)
    assert.equal((await call('tie_secret_use', { secretRef: secret.secretRef })).error, true)
    assert.equal(upstreamCalls, 1)
    const usage = await call('tie_secret_usage', { secretRef: secret.secretRef })
    assert(usage.value.some(event => event.status === 'denied'))
    assert(usage.value.some(event => event.status === 'succeeded'))
    assert.equal(JSON.stringify(usage).includes(value), false)
    assert.equal(usage.value.some(event => event.principal.id === otherToken.record.id), false)
    const ownerUsage = await request('/api/v1/me/secret-usage?workspaceId=' + workspace)
    assert(ownerUsage.payload.some(event => event.principal.id === otherToken.record.id))
  })

  it('supports login-session grants and rejects caller-supplied targets and stale grants after rotation', async () => {
    await grant({ type: 'session', id: 'current' }, null)
    const overridden = await call('tie_secret_use', { secretRef: secret.secretRef, url: 'https://attacker.example' }, session, { 'x-tie-workspace': workspace })
    assert.equal(overridden.error, true)
    assert.equal(upstreamCalls, 1)
    const deniedUsage = await call('tie_secret_usage', {}, session, { 'x-tie-workspace': workspace })
    assert.equal(deniedUsage.value[0].status, 'denied')
    assert.equal(deniedUsage.value[0].reason, 'INVALID_ARGUMENTS')
    const used = await call('tie_secret_use', { secretRef: secret.secretRef }, session, { 'x-tie-workspace': workspace })
    assert.equal(used.error, false)
    assert.equal(upstreamCalls, 2)
    const updated = await request(`/api/v1/me/secrets/${secret.id}`, { method: 'PUT', body: { description: 'Rotated settings invalidate prior approvals' } })
    assert.equal(updated.response.status, 200)
    assert.equal((await call('tie_secret_use', { secretRef: secret.secretRef }, session, { 'x-tie-workspace': workspace })).error, true)
    assert.equal(upstreamCalls, 2)
    const otherWorkspace = (await request('/api/v1/workspaces', { body: { name: 'Other workspace' } })).payload
    const isolated = await call('tie_secret_search', {}, session, { 'x-tie-workspace': otherWorkspace.id })
    assert.deepEqual(isolated.value, [])
    assert.equal((await call('tie_secret_use', { secretRef: secret.secretRef }, session, { 'x-tie-workspace': otherWorkspace.id })).error, true)
  })

  it('revokes an approval immediately and records failed HTTP operations without the upstream body', async () => {
    const tokens = await request('/api/v1/me/mcp-tokens')
    const principal = { type: 'mcp-token', id: tokens.payload.find(item => item.name === 'Vault Agent').id }
    const approved = await grant(principal, null)
    assert.equal((await request('/api/v1/me/secret-grants/' + approved.id, { method: 'DELETE' })).response.status, 204)
    assert.equal((await call('tie_secret_use', { secretRef: secret.secretRef, grantId: approved.id })).error, true)
    const failedSecret = (await request('/api/v1/me/secrets', { body: {
      workspaceId: workspace, name: 'Failing operation', value,
      target: { url: endpoint + '/failing-action', method: 'POST', authType: 'bearer' },
    } })).payload
    await grant(principal, 1, failedSecret.id)
    const failed = await call('tie_secret_use', { secretRef: failedSecret.secretRef })
    assert.equal(failed.error, true)
    assert.equal(failed.value.ok, false)
    assert.equal(failed.value.httpStatus, 503)
    assert.equal(JSON.stringify(failed).includes(value), false)
    const usage = await call('tie_secret_usage', { secretRef: failedSecret.secretRef })
    assert.equal(usage.value[0].status, 'failed')
    assert.equal(usage.value[0].httpStatus, 503)
  })

  it('denies foreign owners and rejects logged-out access tokens for vault maintenance', async () => {
    const foreign = (await request('/api/v1/auth/register', { bearer: '', body: {
      email: 'vault-foreign@example.test', password: 'FixturePassword123', name: 'Foreign user',
    } })).payload
    assert.equal((await request(`/api/v1/me/secrets/${secret.id}/value`, { bearer: foreign.accessToken })).response.status, 404)
    const login = (await request('/api/v1/auth/login', { bearer: '', body: { email: 'vault-owner@example.test', password: 'FixturePassword123' } })).payload
    const bearer = login.accessToken
    const sessions = await request('/api/v1/me/secret-sessions')
    assert.equal(sessions.response.status, 200)
    assert(sessions.payload.some(item => item.current))
    const otherSession = sessions.payload.find(item => !item.current)
    assert(otherSession)
    assert.equal(JSON.stringify(sessions.payload).includes('refreshHash'), false)
    await grant({ type: 'session', id: otherSession.id })
    assert.equal((await call('tie_secret_use', { secretRef: secret.secretRef }, bearer, { 'x-tie-workspace': workspace })).error, false)
    assert.equal((await request(`/api/v1/me/secrets/${secret.id}/value`, { bearer })).response.status, 200)
    await request('/api/v1/auth/logout', { bearer, body: { refreshToken: login.refreshToken } })
    for (const [route, method, body] of [
      [`/api/v1/me/secrets/${secret.id}/value`, 'GET', undefined],
      [`/api/v1/me/secrets/${secret.id}`, 'PUT', { description: 'Must not apply' }],
      [`/api/v1/me/secrets/${secret.id}/grants`, 'POST', { principal: { type: 'session', id: 'current' } }],
    ]) assert.equal((await request(route, { bearer, method, body })).response.status, 401)
    for (const name of ['tie_secret_search', 'tie_secret_usage']) {
      assert.equal((await call(name, {}, bearer, { 'x-tie-workspace': workspace })).error, true)
    }
  })
})
