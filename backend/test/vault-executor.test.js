import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import https from 'node:https'
import { after, before, beforeEach, describe, it } from 'node:test'
import { executeCredential, validateTarget } from '../src/vault-executor.js'

const ca = fs.readFileSync(new URL('./fixtures/vault-ca.pem', import.meta.url))
const key = fs.readFileSync(new URL('./fixtures/vault-server-key.pem', import.meta.url))
const cert = fs.readFileSync(new URL('./fixtures/vault-server-cert.pem', import.meta.url))
const value = 'fixture-only-private/+ credential'
const resolveLocal = async () => [{ address: '127.0.0.1', family: 4 }]

describe('vault fixed-target executor', { concurrency: 1 }, () => {
  let server
  let origin
  let handler
  let requests
  const previousOrigins = process.env.TIE_VAULT_ALLOWED_ORIGINS

  before(async () => {
    server = https.createServer({ key, cert }, async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push({ method: request.method, url: request.url, headers: request.headers, body })
      handler(request, response)
    })
    server.on('tlsClientError', () => {})
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    origin = `https://vault.fixture.test:${server.address().port}`
  })

  after(async () => {
    if (previousOrigins === undefined) delete process.env.TIE_VAULT_ALLOWED_ORIGINS
    else process.env.TIE_VAULT_ALLOWED_ORIGINS = previousOrigins
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  beforeEach(() => {
    requests = []
    process.env.TIE_VAULT_ALLOWED_ORIGINS = origin
    handler = (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ status: 'ok' }))
    }
  })

  function target(overrides = {}) {
    return validateTarget({ url: origin + '/fixed/action?mode=owner', ...overrides })
  }
  function execute(configuration = target(), internal = {}) {
    return executeCredential({ target: configuration, value }, { ca, resolve: resolveLocal, ...internal })
  }

  it('normalizes the owner action and rejects URL, method, header and field injection', () => {
    assert.deepEqual(validateTarget({ url: 'https://example.com:443/a?fixed=1', method: 'post', body: '{}' }), {
      url: 'https://example.com/a?fixed=1', method: 'POST', authType: 'bearer', body: '{}',
    })
    for (const input of [
      { url: 'http://example.com' }, { url: 'https://user:password@example.com' },
      { url: 'https://example.com/#fragment' }, { url: 'https://example.com/#' },
      { url: 'https://example.com', method: 'CONNECT' }, { url: 'https://example.com', headers: {} },
      { url: 'https://example.com', body: '{}' }, { url: 'https://example.com', method: 'POST', body: 'x'.repeat(16385) },
      { url: 'https://example.com', authType: 'basic', username: 'name:password' },
      { url: 'https://example.com', responseFields: ['data.__proto__.value'] },
      { url: 'https://example.com', responseFields: ['constructor'] },
      { url: 'https://example.com', responseFields: ['data.access_token'] },
      { url: 'https://example.com', responseFields: ['data.password'] },
      { url: 'https://example.com', responseFields: ['data[0].id'] },
    ]) assert.throws(() => validateTarget(input), { code: 'INVALID_TARGET', status: 400 })
    for (const headerName of ['Host', 'Cookie', 'Set-Cookie', 'Content-Length', 'Content-Type', 'Proxy-Authorization', 'Connection', 'X-Forwarded-Host', 'X-Key\r\nHost']) {
      assert.throws(() => validateTarget({ url: 'https://example.com', authType: 'header', headerName }), { code: 'INVALID_TARGET' })
    }
  })

  it('injects bearer, custom-header and basic authentication only into the fixed HTTPS action', async () => {
    for (const configuration of [
      target(), target({ authType: 'header', headerName: 'X-Service-Key' }),
      target({ authType: 'basic', username: 'owner', method: 'POST', body: '{"fixed":true}' }),
    ]) {
      const result = await execute(configuration)
      assert.deepEqual(result, { httpStatus: 200 })
    }
    assert.equal(requests[0].headers.authorization, `Bearer ${value}`)
    assert.equal(requests[1].headers['x-service-key'], value)
    assert.equal(requests[2].headers.authorization, `Basic ${Buffer.from(`owner:${value}`).toString('base64')}`)
    assert.equal(requests[2].body, '{"fixed":true}')
    assert.equal(requests[2].url, '/fixed/action?mode=owner')
    assert.equal(requests[2].method, 'POST')
  })

  it('defaults to status only even when the upstream echoes credentials and sensitive headers', async () => {
    handler = (_request, response) => {
      response.statusCode = 401
      response.setHeader('set-cookie', `session=${value}`)
      response.end(JSON.stringify({ token: value, password: value, message: `invalid ${value}` }))
    }
    assert.deepEqual(await execute(), { httpStatus: 401 })
  })

  it('returns only allowlisted short scalars and removes raw and encoded credential echoes', async () => {
    handler = (_request, response) => response.end(JSON.stringify({
      status: 'done', data: { count: 3, enabled: true }, nil: null,
      object: { status: 'nested' }, large: 'x'.repeat(257),
      raw: value, encoded: encodeURIComponent(value), base64: Buffer.from(value).toString('base64'),
      basic: Buffer.from(`owner:${value}`).toString('base64'), token: 'new-upstream-token',
    }))
    const result = await execute(target({ authType: 'basic', username: 'owner', responseFields: [
      'status', 'data.count', 'data.enabled', 'nil', 'object', 'large', 'raw', 'encoded', 'base64', 'basic', 'missing',
    ] }))
    assert.deepEqual(result, { httpStatus: 200, fields: { status: 'done', 'data.count': 3, 'data.enabled': true, nil: null } })
    assert.ok(!JSON.stringify(result).includes(value))
  })

  it('never follows redirect responses or returns their location or response body', async () => {
    handler = (_request, response) => {
      response.statusCode = 302
      response.setHeader('location', `https://other.example/${value}`)
      response.end(value)
    }
    await assert.rejects(execute(), (error) => error.code === 'TARGET_REDIRECT' && !error.message.includes(value) && !error.message.includes('other.example'))
    assert.equal(requests.length, 1)
  })

  it('enforces the 64 KiB response limit even when only status was requested', async () => {
    handler = (_request, response) => response.end(Buffer.alloc(65537, 'a'))
    await assert.rejects(execute(), { code: 'TARGET_TOO_LARGE' })
    handler = (_request, response) => response.end(Buffer.alloc(65536, 'a'))
    assert.deepEqual(await execute(), { httpStatus: 200 })
  })

  it('times out both unresolved DNS and an upstream that does not finish its response', async () => {
    await assert.rejects(execute(target(), { timeoutMs: 30, resolve: () => new Promise(() => {}) }), { code: 'TARGET_TIMEOUT' })
    assert.equal(requests.length, 0)
    handler = (_request, response) => response.write('waiting')
    await assert.rejects(execute(target(), { timeoutMs: 60 }), { code: 'TARGET_TIMEOUT' })
    assert.equal(requests.length, 1)
  })

  it('requires exact administrator origin approval for private targets, including the port', async () => {
    process.env.TIE_VAULT_ALLOWED_ORIGINS = ''
    await assert.rejects(execute(), { code: 'TARGET_NOT_ALLOWED' })
    process.env.TIE_VAULT_ALLOWED_ORIGINS = 'https://vault.fixture.test:1'
    await assert.rejects(execute(), { code: 'TARGET_NOT_ALLOWED' })
    assert.equal(requests.length, 0)
    process.env.TIE_VAULT_ALLOWED_ORIGINS = origin
    assert.deepEqual(await execute(), { httpStatus: 200 })
  })

  it('rejects any forbidden DNS answer and pins the approved lookup without resolving again', async () => {
    process.env.TIE_VAULT_ALLOWED_ORIGINS = ''
    await assert.rejects(execute(target(), { resolve: async () => [
      { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
    ] }), { code: 'TARGET_NOT_ALLOWED' })
    process.env.TIE_VAULT_ALLOWED_ORIGINS = origin
    await assert.rejects(execute(target(), { resolve: async () => [
      { address: '127.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 },
    ] }), { code: 'TARGET_NOT_ALLOWED' })
    assert.equal(requests.length, 0)
    let lookups = 0
    const result = await execute(target(), { resolve: async (_hostname, options) => {
      assert.equal(options.all, true)
      lookups += 1
      return lookups === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '169.254.169.254', family: 4 }]
    } })
    assert.deepEqual(result, { httpStatus: 200 })
    assert.equal(lookups, 1)
    assert.equal(requests.length, 1)
  })

  it('always blocks metadata, link-local, unspecified, multicast and reserved addresses', async () => {
    for (const address of ['169.254.169.254', '0.0.0.0', '100.100.100.200', '224.0.0.1', '192.0.2.1',
      '::', 'fe80::1', 'ff02::1', 'fd00:ec2::254', '2001:db8::1', '2002:7f00:1::', '::ffff:169.254.169.254']) {
      const literal = address.includes(':') ? `[${address}]` : address
      process.env.TIE_VAULT_ALLOWED_ORIGINS = `https://${literal}`
      await assert.rejects(execute(validateTarget({ url: `https://${literal}/` })), { code: 'TARGET_NOT_ALLOWED' })
    }
    assert.equal(requests.length, 0)
  })

  it('rejects alternate numeric loopback spellings without administrator approval', async () => {
    process.env.TIE_VAULT_ALLOWED_ORIGINS = ''
    for (const url of ['https://2130706433/', 'https://0x7f000001/', 'https://127.1/', 'https://[::ffff:127.0.0.1]/']) {
      await assert.rejects(execute(validateTarget({ url })), { code: 'TARGET_NOT_ALLOWED' })
    }
    assert.equal(requests.length, 0)
  })

  it('keeps certificate trust and hostname verification enabled', async () => {
    await assert.rejects(executeCredential({ target: target(), value }, { resolve: resolveLocal }), { code: 'TARGET_UNAVAILABLE' })
    const wrongOrigin = origin.replace('vault.fixture.test', 'wrong.fixture.test')
    process.env.TIE_VAULT_ALLOWED_ORIGINS = wrongOrigin
    await assert.rejects(execute(target({ url: wrongOrigin + '/fixed' })), { code: 'TARGET_UNAVAILABLE' })
    assert.equal(requests.length, 0)
  })
})
