import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { store } from '../src/store.js'
import * as vault from '../src/vault.js'

const owner = 'usr_vault_owner'
const other = 'usr_vault_other'
const workspaceId = 'ws_vault_main'
const principal = { type: 'mcp-token', id: 'mtok_vault_owner' }
const sessionPrincipal = { type: 'session', id: 'ses_vault_owner' }
const caller = { userId: owner, workspaceId, principal }
const value = 'VAULT_FIXTURE_CANARY_NOT_A_REAL_CREDENTIAL'
const input = {
  workspaceId, name: 'Example API', description: 'Read account status', service: 'Example', environment: 'test', tags: ['api'],
  value, target: { url: 'https://api.example.test/v1/private-action', method: 'POST', authType: 'bearer', body: '{"action":"status"}', responseFields: ['status'] },
}
let dataDir
let previousRoot
let previousKeyFile
const disk = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'vault.json'), 'utf8'))
const saveDisk = data => fs.writeFileSync(path.join(dataDir, 'vault.json'), JSON.stringify(data))
const create = overrides => vault.createSecret(owner, { ...input, ...overrides })
const grant = (secret, overrides = {}) => vault.createGrant(owner, secret.id, { principal, ...overrides })
const use = (secret, grantId) => vault.authorizeUse(caller, { secretRef: secret.secretRef, ...(grantId ? { grantId } : {}) })

describe('server credential vault', { concurrency: 1 }, () => {
  beforeEach(() => {
    previousRoot = process.env.TIE_DATA_DIR
    previousKeyFile = process.env.TIE_VAULT_KEY_FILE
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-vault-test-'))
    process.env.TIE_DATA_DIR = dataDir
    delete process.env.TIE_VAULT_KEY_FILE
    store.saveUsers([{ id: owner }, { id: other }])
    store.saveWorkspaces([
      { id: workspaceId, ownerId: owner }, { id: 'ws_vault_second', ownerId: owner }, { id: 'ws_vault_other', ownerId: other },
    ])
    store.saveMcpTokens([
      { id: principal.id, userId: owner, workspaceId },
      { id: 'mtok_vault_second', userId: owner, workspaceId: 'ws_vault_second' },
      { id: 'mtok_vault_other', userId: other, workspaceId: 'ws_vault_other' },
    ])
    store.saveSessions([{ id: sessionPrincipal.id, userId: owner, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }])
  })

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
    if (previousRoot === undefined) delete process.env.TIE_DATA_DIR
    else process.env.TIE_DATA_DIR = previousRoot
    if (previousKeyFile === undefined) delete process.env.TIE_VAULT_KEY_FILE
    else process.env.TIE_VAULT_KEY_FILE = previousKeyFile
  })

  it('encrypts values with an independent persistent private key and returns metadata only', () => {
    const first = create()
    const second = create({ name: 'Second API' })
    assert.equal(vault.revealSecret(owner, first.id), value)
    const saved = disk()
    assert.notEqual(saved.secrets[0].encryptedValue.iv, saved.secrets[1].encryptedValue.iv)
    assert.notEqual(saved.secrets[0].encryptedValue.ciphertext, saved.secrets[1].encryptedValue.ciphertext)
    assert.ok(!fs.readFileSync(path.join(dataDir, 'vault.json'), 'utf8').includes(value))
    assert.ok(!('value' in first) && !('encryptedValue' in first) && !('target' in first))
    assert.deepEqual(first.action, { method: 'POST', origin: 'https://api.example.test' })
    assert.deepEqual(vault.getSecret(owner, first.id).target, input.target)
    assert.equal(vault.getSecret(owner, second.id).value, undefined)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(dataDir, '.private')).mode & 0o777, 0o700)
      assert.equal(fs.statSync(path.join(dataDir, '.private/vault.key')).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.join(dataDir, 'vault.json')).mode & 0o777, 0o600)
    }
    assert.equal(fs.existsSync(path.join(dataDir, 'workspaces', workspaceId, 'vault.json')), false)
  })

  it('saves a value without an HTTP action and preserves it through metadata edits', () => {
    const secret = vault.createSecret(owner, { workspaceId, name: 'Private note', value })
    assert.equal(secret.action, null)
    assert.equal(vault.getSecret(owner, secret.id).target, null)
    assert.equal(vault.revealSecret(owner, secret.id), value)
    assert.ok(!fs.readFileSync(path.join(dataDir, 'vault.json'), 'utf8').includes(value))
    assert.deepEqual(vault.listSecrets(owner, { query: 'Private note' }), [secret])
    assert.deepEqual(vault.listSecrets(owner, { query: value }), [])
    const edited = vault.updateSecret(owner, secret.id, { name: 'Renamed private note', description: 'For personal use' })
    assert.equal(edited.version, 2)
    assert.equal(edited.action, null)
    assert.equal(vault.revealSecret(owner, secret.id), value)
    assert.throws(() => vault.revealSecret(other, secret.id), { code: 'SECRET_NOT_FOUND' })
    vault.deleteSecret(owner, secret.id)
    assert.throws(() => vault.getSecret(owner, secret.id), { code: 'SECRET_NOT_FOUND' })
  })

  it('requires an action before granting or using a stored value, and revokes grants when the action is removed', () => {
    const secret = create({ target: null })
    assert.throws(() => grant(secret), { code: 'ACTION_REQUIRED', status: 409 })
    // The refusal must precede decryption: a missing key does not change it to a decrypt/key failure.
    const keyFile = path.join(dataDir, '.private/vault.key')
    const key = fs.readFileSync(keyFile)
    fs.rmSync(keyFile)
    assert.throws(() => use(secret), { code: 'ACTION_REQUIRED', status: 409 })
    const [denied] = vault.listUsage(owner, { workspaceId })
    assert.equal(denied.reason, 'ACTION_REQUIRED')
    assert.equal(denied.action, null)
    assert.ok(!JSON.stringify(denied).includes(value))
    fs.writeFileSync(keyFile, key, { mode: 0o600 })

    const configured = vault.updateSecret(owner, secret.id, { target: input.target })
    const permission = grant(configured, { maxUses: null })
    assert.equal(use(configured, permission.id).value, value)
    const renamed = vault.updateSecret(owner, secret.id, { name: 'Rename without clearing action' })
    assert.deepEqual(renamed.action, { method: 'POST', origin: 'https://api.example.test' })
    assert.deepEqual(vault.getSecret(owner, secret.id).target, input.target)
    grant(renamed)
    const cleared = vault.updateSecret(owner, secret.id, { target: null })
    assert.equal(cleared.action, null)
    assert.ok(vault.listGrants(owner, { secretRef: secret.secretRef }).every(item => item.revokedAt))
    assert.throws(() => use(cleared), { code: 'ACTION_REQUIRED' })
    assert.equal(vault.revealSecret(owner, secret.id), value)
    for (const target of [{}, '', false, { url: 'http://example.test' }]) {
      assert.throws(() => create({ target }), { code: 'INVALID_TARGET' })
    }
  })

  it('uses an external private master key and never silently replaces a missing key', () => {
    const keyPath = path.join(dataDir, 'external-vault.key')
    const key = crypto.randomBytes(32)
    fs.writeFileSync(keyPath, key.toString('base64') + '\n', { mode: 0o600 })
    process.env.TIE_VAULT_KEY_FILE = keyPath
    const secret = create()
    assert.equal(fs.existsSync(path.join(dataDir, '.private/vault.key')), false)
    fs.writeFileSync(keyPath, crypto.randomBytes(32))
    assert.throws(() => vault.revealSecret(owner, secret.id), { code: 'VAULT_DECRYPT_FAILED' })
    fs.writeFileSync(keyPath, key)
    assert.equal(vault.revealSecret(owner, secret.id), value)
    fs.rmSync(keyPath)
    assert.throws(() => vault.revealSecret(owner, secret.id), { code: 'VAULT_KEY_MISSING' })
    assert.equal(fs.existsSync(keyPath), false)
  })

  it('rejects a public-readable or workspace-contained master key', () => {
    const file = path.join(dataDir, 'bad-vault.key')
    fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o644 })
    process.env.TIE_VAULT_KEY_FILE = file
    if (process.platform !== 'win32') assert.throws(() => create(), { code: 'VAULT_KEY_PERMISSIONS' })
    const inside = path.join(dataDir, 'workspaces', workspaceId, 'vault.key')
    fs.mkdirSync(path.dirname(inside), { recursive: true })
    fs.writeFileSync(inside, crypto.randomBytes(32), { mode: 0o600 })
    process.env.TIE_VAULT_KEY_FILE = inside
    assert.throws(() => create(), { code: 'VAULT_KEY_IN_WORKSPACE' })
  })

  it('does not generate a key through a private-directory link into a workspace', { skip: process.platform === 'win32' }, () => {
    const workspace = path.join(dataDir, 'workspaces', workspaceId)
    fs.mkdirSync(workspace, { recursive: true })
    fs.symlinkSync(workspace, path.join(dataDir, '.private'), 'dir')
    assert.throws(() => create(), { code: 'VAULT_KEY_IN_WORKSPACE' })
    assert.equal(fs.existsSync(path.join(workspace, 'vault.key')), false)
  })

  it('isolates owners and workspaces and searches only metadata', () => {
    const mine = create()
    create({ workspaceId: 'ws_vault_second', name: 'Other workspace' })
    vault.createSecret(other, { ...input, workspaceId: 'ws_vault_other' })
    assert.deepEqual(vault.listSecrets(owner, { workspaceId, service: 'example', environment: 'TEST', query: 'account', limit: '1' }), [mine])
    assert.deepEqual(vault.listSecrets(owner, { workspaceId, query: value }), [])
    assert.equal(vault.listSecrets(owner).length, 2)
    for (const fn of [() => vault.getSecret(other, mine.id), () => vault.revealSecret(other, mine.id),
      () => vault.updateSecret(other, mine.id, { name: 'Foreign' }), () => vault.deleteSecret(other, mine.id)]) {
      assert.throws(fn, { code: 'SECRET_NOT_FOUND', status: 404 })
    }
    assert.throws(() => create({ workspaceId: 'ws_vault_other' }), { code: 'WORKSPACE_NOT_FOUND' })
    assert.throws(() => vault.listSecrets(owner, { limit: 'invalid' }), { code: 'INVALID_ARGUMENTS' })
  })

  it('rejects copying plaintext into public metadata or target configuration', () => {
    for (const overrides of [{ name: value }, { description: value }, { tags: [value] },
      { target: { ...input.target, body: JSON.stringify({ credential: value }) } },
      { target: { ...input.target, url: `https://api.example.test/${value}` } }]) {
      assert.throws(() => create(overrides), { code: 'VALUE_IN_METADATA' })
    }
    const secret = create()
    assert.throws(() => vault.updateSecret(owner, secret.id, { description: value }), { code: 'VALUE_IN_METADATA' })
    assert.throws(() => vault.updateSecret(owner, secret.id, { value: 'ROTATED_FIXTURE', description: value }), { code: 'VALUE_IN_METADATA' })
  })

  it('consumes a once grant before returning and records only safe usage metadata', () => {
    const secret = create()
    const permission = grant(secret)
    assert.equal(permission.maxUses, 1)
    assert.equal(permission.useCount, 0)
    const used = use(secret, permission.id)
    assert.equal(used.value, value)
    assert.equal(vault.listGrants(owner, { workspaceId })[0].useCount, 1)
    assert.throws(() => use(secret, permission.id), { code: 'GRANT_REQUIRED' })
    vault.finishUse(used.eventId, { status: 'failed', httpStatus: 503, reason: `response ${value} ${input.target.url}` })
    const usage = vault.listUsage(owner, { workspaceId, principal, limit: '10' })
    const finished = usage.find(item => item.id === used.eventId)
    assert.deepEqual(finished.action, secret.action)
    assert.equal(finished.version, secret.version)
    assert.equal(finished.grantId, permission.id)
    assert.equal(finished.status, 'failed')
    assert.equal(finished.reason, 'USE_FAILED')
    assert.equal(usage[0].status, 'denied')
    assert.ok(!JSON.stringify(usage).includes(value))
    assert.ok(!JSON.stringify(usage).includes('/v1/private-action'))
    assert.ok(!JSON.stringify(usage).includes(input.target.body))
    assert.deepEqual(vault.listUsage(other), [])
    assert.equal(vault.finishUse(used.eventId, { status: 'succeeded' }).status, 'failed')
  })

  it('invalidates old grants on edits, requires a new grant, and binds ciphertext to the secret identity', () => {
    const secret = create()
    const oldGrant = grant(secret, { maxUses: null })
    const next = vault.updateSecret(owner, secret.id, { value: 'ROTATED_VAULT_FIXTURE', target: { ...input.target, method: 'PUT' } })
    assert.equal(next.version, 2)
    assert.ok(vault.listGrants(owner, { secretRef: secret.secretRef })[0].revokedAt)
    assert.throws(() => use(next, oldGrant.id), { code: 'GRANT_REQUIRED' })
    const nextGrant = grant(next)
    assert.equal(use(next, nextGrant.id).value, 'ROTATED_VAULT_FIXTURE')
    const second = create({ name: 'Second' })
    const data = disk()
    data.secrets.find(item => item.id === second.id).encryptedValue = data.secrets.find(item => item.id === next.id).encryptedValue
    saveDisk(data)
    assert.throws(() => vault.revealSecret(owner, second.id), { code: 'VAULT_DECRYPT_FAILED' })
  })

  it('checks principal ownership, scope, revocation and session lifetime at use time', () => {
    const secret = create()
    assert.throws(() => grant(secret, { principal: { type: 'mcp-token', id: 'mtok_vault_other' } }), { code: 'PRINCIPAL_UNAVAILABLE' })
    assert.throws(() => grant(secret, { principal: { type: 'mcp-token', id: 'mtok_vault_second' } }), { code: 'PRINCIPAL_UNAVAILABLE' })
    const permission = grant(secret)
    vault.revokeGrant(owner, permission.id)
    assert.throws(() => use(secret), { code: 'GRANT_REQUIRED' })
    const sessionGrant = grant(secret, { principal: sessionPrincipal })
    const sessionCaller = { ...caller, principal: sessionPrincipal }
    assert.equal(vault.validateCaller(sessionCaller).principal.id, sessionPrincipal.id)
    store.saveSessions([])
    assert.throws(() => vault.validateCaller(sessionCaller), { code: 'PRINCIPAL_UNAVAILABLE' })
    assert.throws(() => vault.authorizeUse(sessionCaller, { secretRef: secret.secretRef, grantId: sessionGrant.id }), { code: 'PRINCIPAL_UNAVAILABLE' })
    store.saveMcpTokens([])
    assert.throws(() => vault.validateCaller(caller), { code: 'PRINCIPAL_UNAVAILABLE' })
    assert.throws(() => use(secret), { code: 'PRINCIPAL_UNAVAILABLE' })
  })

  it('rejects invalid lifetimes, enforces expiry, and bounds grant usage options', context => {
    const secret = create()
    for (const duration of [1000, 31 * 86_400_000]) {
      assert.throws(() => grant(secret, { expiresAt: new Date(Date.now() + duration).toISOString() }), { code: 'INVALID_GRANT_EXPIRY' })
    }
    assert.throws(() => grant(secret, { maxUses: 2 }), { code: 'INVALID_GRANT_LIMIT' })
    const permission = grant(secret, { expiresAt: new Date(Date.now() + 120_000).toISOString(), maxUses: null })
    context.mock.method(Date, 'now', () => Date.parse(permission.expiresAt) + 1)
    assert.throws(() => use(secret), { code: 'GRANT_REQUIRED' })
  })

  it('audits malformed use arguments under the validated principal without logging their contents', () => {
    const secret = create()
    grant(secret)
    assert.throws(() => vault.authorizeUse(caller, { secretRef: secret.secretRef, body: value }), { code: 'INVALID_ARGUMENTS' })
    const [event] = vault.listUsage(owner, { workspaceId, principal })
    assert.equal(event.status, 'denied')
    assert.deepEqual(event.principal, principal)
    assert.equal(event.secretRef, null)
    assert.equal(event.reason, 'INVALID_ARGUMENTS')
    assert.ok(!JSON.stringify(event).includes(value))
    assert.equal(vault.listGrants(owner, {})[0].useCount, 0)
  })

  it('rechecks disabled users and workspace ownership, and revokes grants when deleting a secret', () => {
    const secret = create()
    grant(secret)
    store.saveUsers([{ id: owner, disabled: true }, { id: other }])
    assert.throws(() => vault.validateCaller(caller), { code: 'ACCOUNT_DISABLED' })
    store.saveUsers([{ id: owner }, { id: other }])
    assert.throws(() => vault.validateCaller({ ...caller, workspaceId: 'ws_vault_other' }), { code: 'WORKSPACE_NOT_FOUND' })
    vault.deleteSecret(owner, secret.id)
    assert.ok(vault.listGrants(owner)[0].revokedAt)
    assert.throws(() => use(secret), { code: 'SECRET_NOT_FOUND' })
    assert.throws(() => vault.revealSecret(owner, secret.id), { code: 'SECRET_NOT_FOUND' })
  })
})
