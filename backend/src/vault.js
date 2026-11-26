import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { store } from './store.js'
import { validateTarget } from './vault-executor.js'

const MIN_GRANT_MS = 60_000
const MAX_GRANT_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_GRANT_MS = 60 * 60 * 1000
const SECRET_FIELDS = ['workspaceId', 'name', 'description', 'service', 'environment', 'tags', 'target', 'value']
const AUDIT_REASONS = new Set([
  'INVALID_ARGUMENTS', 'INVALID_PRINCIPAL', 'INVALID_SECRET_REF', 'OWNER_NOT_FOUND', 'ACCOUNT_DISABLED',
  'WORKSPACE_NOT_FOUND', 'SECRET_NOT_FOUND', 'PRINCIPAL_UNAVAILABLE', 'GRANT_REQUIRED', 'VAULT_ERROR',
  'VAULT_KEY_MISSING', 'VAULT_KEY_UNAVAILABLE', 'VAULT_KEY_PERMISSIONS', 'VAULT_KEY_INVALID',
  'VAULT_KEY_IN_WORKSPACE', 'VAULT_DECRYPT_FAILED', 'TARGET_FAILED', 'USE_FAILED', 'INVALID_TARGET',
  'TARGET_NOT_ALLOWED', 'TARGET_DNS', 'TARGET_POLICY', 'TARGET_TIMEOUT', 'TARGET_REDIRECT',
  'TARGET_TOO_LARGE', 'TARGET_UNAVAILABLE', 'TARGET_CREDENTIAL',
])
const newId = prefix => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
const nowIso = () => new Date().toISOString()
const secretRef = secret => `secret://${secret.id}`

export function createSecret(ownerId, input) {
  requireOwner(ownerId)
  objectInput(input, SECRET_FIELDS)
  const value = secretValue(input.value)
  const fields = secretFields(ownerId, input)
  rejectValueCopies(fields, value)
  rejectValueCopies(input.target, value)
  const data = readVault()
  const stamp = nowIso()
  const record = { id: newId('sec'), ownerId, ...fields, version: 1, createdAt: stamp, updatedAt: stamp }
  record.encryptedValue = encryptValue(value, record, masterKey(data))
  data.secrets.push(record)
  writeVault(data)
  return metadata(record)
}

export function getSecret(ownerId, id) {
  requireOwner(ownerId)
  const secret = ownedSecret(readVault(), ownerId, id)
  return { ...metadata(secret), target: structuredClone(secret.target) }
}

export function updateSecret(ownerId, id, input) {
  requireOwner(ownerId)
  objectInput(input, SECRET_FIELDS)
  if (!Object.keys(input).length) fail('INVALID_ARGUMENTS', '没有要更新的凭据字段', 400)
  const data = readVault()
  const previous = ownedSecret(data, ownerId, id)
  const key = masterKey(data)
  const previousValue = decryptValue(previous, key)
  const value = input.value === undefined ? previousValue : secretValue(input.value)
  const fields = secretFields(ownerId, { ...previous, ...input })
  rejectValueCopies(fields, value)
  rejectValueCopies(fields, previousValue)
  if (input.target !== undefined) {
    rejectValueCopies(input.target, value)
    rejectValueCopies(input.target, previousValue)
  }
  const stamp = nowIso()
  const next = { ...previous, ...fields, version: previous.version + 1, updatedAt: stamp }
  next.encryptedValue = encryptValue(value, next, key)
  data.secrets = data.secrets.map(item => item.id === id ? next : item)
  revokeSecretGrants(data, secretRef(previous), stamp)
  writeVault(data)
  return metadata(next)
}

export function deleteSecret(ownerId, id) {
  requireOwner(ownerId)
  const data = readVault()
  const secret = ownedSecret(data, ownerId, id)
  data.secrets = data.secrets.filter(item => item.id !== id)
  revokeSecretGrants(data, secretRef(secret), nowIso())
  writeVault(data)
  return true
}

export function listSecrets(ownerId, options = {}) {
  requireOwner(ownerId)
  objectInput(options, ['workspaceId', 'query', 'service', 'environment', 'limit'])
  const workspaceId = workspaceFilter(ownerId, options.workspaceId)
  const query = optionalText(options.query, 500).toLowerCase()
  const service = optionalText(options.service, 100).toLowerCase()
  const environment = optionalText(options.environment, 100).toLowerCase()
  const limit = resultLimit(options.limit)
  return readVault().secrets.filter(item => item.ownerId === ownerId
    && (!workspaceId || item.workspaceId === workspaceId)
    && (!service || item.service.toLowerCase() === service)
    && (!environment || item.environment.toLowerCase() === environment)
    && (!query || [item.name, item.description, item.service, item.environment, ...item.tags].join(' ').toLowerCase().includes(query)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map(metadata)
}

export function revealSecret(ownerId, id) {
  requireOwner(ownerId)
  const data = readVault()
  const secret = ownedSecret(data, ownerId, id)
  return decryptValue(secret, masterKey(data))
}

export function createGrant(ownerId, secretId, input) {
  requireOwner(ownerId)
  objectInput(input, ['principal', 'expiresAt', 'maxUses'])
  const data = readVault()
  const secret = ownedSecret(data, ownerId, secretId)
  const principal = principalInput(input.principal)
  requireLivePrincipal(ownerId, secret.workspaceId, principal)
  const now = Date.now()
  const expires = input.expiresAt === undefined ? now + DEFAULT_GRANT_MS : Date.parse(input.expiresAt)
  if ((input.expiresAt !== undefined && typeof input.expiresAt !== 'string')
      || !Number.isFinite(expires) || expires < now + MIN_GRANT_MS || expires > now + MAX_GRANT_MS) {
    fail('INVALID_GRANT_EXPIRY', '授权有效期须在 1 分钟到 30 天之间', 400)
  }
  const maxUses = input.maxUses === undefined ? 1 : input.maxUses
  if (maxUses !== 1 && maxUses !== null) fail('INVALID_GRANT_LIMIT', '授权次数只能为一次或不限次数', 400)
  const grant = {
    id: newId('grant'), ownerId, secretRef: secretRef(secret), workspaceId: secret.workspaceId,
    principal, expiresAt: new Date(expires).toISOString(), maxUses, useCount: 0,
    revokedAt: null, createdAt: new Date(now).toISOString(), version: secret.version,
  }
  data.grants.push(grant)
  writeVault(data)
  return grantMetadata(grant)
}

export function listGrants(ownerId, options = {}) {
  requireOwner(ownerId)
  objectInput(options, ['workspaceId', 'secretRef'])
  const workspaceId = workspaceFilter(ownerId, options.workspaceId)
  const ref = options.secretRef === undefined ? null : referenceInput(options.secretRef)
  return readVault().grants.filter(item => item.ownerId === ownerId
    && (!workspaceId || item.workspaceId === workspaceId) && (!ref || item.secretRef === ref))
    .reverse().map(grantMetadata)
}

export function revokeGrant(ownerId, id) {
  requireOwner(ownerId)
  const data = readVault()
  const grant = data.grants.find(item => item.id === id && item.ownerId === ownerId)
  if (!grant) fail('GRANT_NOT_FOUND', '授权不存在', 404)
  grant.revokedAt ||= nowIso()
  writeVault(data)
  return true
}

export function validateCaller(caller) {
  objectInput(caller, ['userId', 'workspaceId', 'principal'])
  const principal = principalInput(caller.principal)
  requireOwner(caller.userId)
  requireWorkspace(caller.userId, caller.workspaceId)
  requireLivePrincipal(caller.userId, caller.workspaceId, principal)
  return { userId: caller.userId, workspaceId: caller.workspaceId, principal }
}

export function authorizeUse(caller, input) {
  const data = readVault()
  const event = {
    id: newId('use'), ownerId: caller?.userId, workspaceId: caller?.workspaceId,
    secretRef: null, principal: null, at: nowIso(), status: 'started',
  }
  let result
  let denied
  try {
    const trusted = validateCaller(caller)
    event.ownerId = trusted.userId
    event.workspaceId = trusted.workspaceId
    event.principal = trusted.principal
    objectInput(input, ['secretRef', 'grantId'])
    event.secretRef = referenceInput(input.secretRef)
    const secret = data.secrets.find(item => secretRef(item) === event.secretRef
      && item.ownerId === caller.userId && item.workspaceId === caller.workspaceId)
    if (!secret) fail('SECRET_NOT_FOUND', '凭据不存在', 404)
    event.action = metadata(secret).action
    event.version = secret.version
    if (input.grantId !== undefined && typeof input.grantId !== 'string') fail('INVALID_ARGUMENTS', '授权标识无效', 400)
    const grant = [...data.grants].reverse().find(item => item.ownerId === caller.userId
      && item.secretRef === event.secretRef && item.workspaceId === caller.workspaceId
      && item.principal.type === event.principal.type && item.principal.id === event.principal.id
      && (input.grantId === undefined || item.id === input.grantId)
      && !item.revokedAt && item.version === secret.version && Date.parse(item.expiresAt) > Date.now()
      && (item.maxUses === null || item.useCount < item.maxUses))
    if (!grant) fail('GRANT_REQUIRED', '需要本人为当前凭据和当前连接签发有效授权', 403)
    event.grantId = grant.id
    const value = decryptValue(secret, masterKey(data))
    grant.useCount += 1
    result = { secret: { ...metadata(secret), target: structuredClone(secret.target) }, value, grantId: grant.id, eventId: event.id }
  } catch (error) {
    denied = error.status && error.code ? error : vaultError('VAULT_ERROR', '凭据服务暂时不可用', 500)
    event.status = 'denied'
    event.reason = auditReason(denied.code)
  }
  // Persist consumption before the caller can await an external request.
  data.usage.push(event)
  writeVault(data)
  if (denied) throw denied
  return result
}

export function finishUse(eventId, input) {
  objectInput(input, ['status', 'httpStatus', 'reason'])
  if (!['succeeded', 'failed'].includes(input.status)) fail('INVALID_ARGUMENTS', '使用结果状态无效', 400)
  if (input.httpStatus !== undefined && (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)) {
    fail('INVALID_ARGUMENTS', 'HTTP 状态无效', 400)
  }
  const data = readVault()
  const event = data.usage.find(item => item.id === eventId)
  if (!event) fail('USAGE_NOT_FOUND', '使用记录不存在', 404)
  if (event.status !== 'started') return usageMetadata(event)
  event.status = input.status
  if (input.httpStatus !== undefined) event.httpStatus = input.httpStatus
  if (input.reason !== undefined) event.reason = auditReason(input.reason)
  writeVault(data)
  return usageMetadata(event)
}

export function listUsage(ownerId, options = {}) {
  requireOwner(ownerId)
  objectInput(options, ['workspaceId', 'secretRef', 'principal', 'limit'])
  const workspaceId = workspaceFilter(ownerId, options.workspaceId)
  const ref = options.secretRef === undefined ? null : referenceInput(options.secretRef)
  const principal = options.principal === undefined ? null : principalInput(options.principal)
  const limit = resultLimit(options.limit)
  return readVault().usage.filter(item => item.ownerId === ownerId
    && (!workspaceId || item.workspaceId === workspaceId) && (!ref || item.secretRef === ref)
    && (!principal || (item.principal?.type === principal.type && item.principal.id === principal.id)))
    .reverse().slice(0, limit).map(usageMetadata)
}

function metadata(secret) {
  const { id, ownerId, workspaceId, name, description, service, environment, tags, version, createdAt, updatedAt } = secret
  return { id, secretRef: secretRef(secret), ownerId, workspaceId, name, description, service, environment,
    tags: [...tags], version, createdAt, updatedAt, action: { method: secret.target.method, origin: new URL(secret.target.url).origin } }
}

function grantMetadata(grant) {
  const { ownerId, ...publicGrant } = grant
  return structuredClone(publicGrant)
}

function usageMetadata(event) {
  const { ownerId, ...publicEvent } = event
  return structuredClone(publicEvent)
}

function secretFields(ownerId, input) {
  const workspaceId = resourceId(input.workspaceId)
  requireWorkspace(ownerId, workspaceId)
  const name = optionalText(input.name, 120)
  if (!name) fail('INVALID_ARGUMENTS', '凭据名称不能为空', 400)
  if (!Array.isArray(input.tags ?? []) || (input.tags ?? []).length > 20) fail('INVALID_ARGUMENTS', '标签无效', 400)
  const tags = [...new Set((input.tags ?? []).map(tag => {
    const value = optionalText(tag, 64)
    if (!value) fail('INVALID_ARGUMENTS', '标签不能为空', 400)
    return value
  }))]
  return { workspaceId, name, description: optionalText(input.description, 2000), service: optionalText(input.service, 100),
    environment: optionalText(input.environment, 100), tags, target: validateTarget(input.target) }
}

function rejectValueCopies(fields, value) {
  const strings = object => typeof object === 'string' ? [object]
    : object && typeof object === 'object' ? Object.values(object).flatMap(strings) : []
  if (strings(fields).some(text => text.includes(value))) {
    fail('VALUE_IN_METADATA', '凭据值不能复制到名称、说明、标签或操作配置中', 400)
  }
}

function secretValue(value) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 65536) fail('INVALID_SECRET_VALUE', '凭据值须为非空文本且不超过 64 KiB', 400)
  return value
}

function requireOwner(ownerId) {
  const user = store.loadUsers().find(item => item.id === ownerId)
  if (!user) fail('OWNER_NOT_FOUND', '账号不存在', 401)
  if (user.disabled) fail('ACCOUNT_DISABLED', '账号已停用', 403)
}

function requireWorkspace(ownerId, workspaceId) {
  const workspace = store.loadWorkspaces().find(item => item.id === workspaceId && item.ownerId === ownerId)
  if (!workspace) fail('WORKSPACE_NOT_FOUND', '工作区不存在', 404)
}

function workspaceFilter(ownerId, value) {
  if (value === undefined) return null
  const id = resourceId(value)
  requireWorkspace(ownerId, id)
  return id
}

function requireLivePrincipal(ownerId, workspaceId, principal) {
  if (principal.type === 'mcp-token') {
    const token = store.loadMcpTokens().find(item => item.id === principal.id && item.userId === ownerId && item.workspaceId === workspaceId)
    if (!token || token.revokedAt || token.disabled) fail('PRINCIPAL_UNAVAILABLE', 'MCP 令牌不存在、已撤销或不属于此工作区', 403)
  } else {
    const session = store.loadSessions().find(item => item.id === principal.id && item.userId === ownerId)
    if (!session || session.revokedAt || !(Date.parse(session.expiresAt) > Date.now())) fail('PRINCIPAL_UNAVAILABLE', '登录会话不存在或已失效', 403)
  }
}

function principalInput(input) {
  objectInput(input, ['type', 'id'])
  if (!['mcp-token', 'session'].includes(input.type)) fail('INVALID_PRINCIPAL', '连接身份类型无效', 400)
  return { type: input.type, id: resourceId(input.id) }
}

function ownedSecret(data, ownerId, id) {
  const secret = data.secrets.find(item => item.id === id && item.ownerId === ownerId)
  if (!secret) fail('SECRET_NOT_FOUND', '凭据不存在', 404)
  requireWorkspace(ownerId, secret.workspaceId)
  return secret
}

function referenceInput(ref) {
  if (typeof ref !== 'string' || !/^secret:\/\/sec_[a-f0-9]{32}$/.test(ref)) fail('INVALID_SECRET_REF', '凭据引用无效', 400)
  return ref
}

function resourceId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) fail('INVALID_ARGUMENTS', '资源标识无效', 400)
  return value
}

function optionalText(value, max) {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > max) fail('INVALID_ARGUMENTS', '文本字段无效或过长', 400)
  return value.trim()
}

function objectInput(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) {
    fail('INVALID_ARGUMENTS', '凭据参数无效或包含不允许的字段', 400)
  }
}

function resultLimit(value) {
  const number = value === undefined ? 20 : typeof value === 'string' && value.trim() ? Number(value) : value
  if (!Number.isInteger(number) || number < 1 || number > 100) fail('INVALID_ARGUMENTS', '返回数量须为 1 到 100 的整数', 400)
  return number
}

function revokeSecretGrants(data, ref, stamp) {
  for (const grant of data.grants) if (grant.secretRef === ref && !grant.revokedAt) grant.revokedAt = stamp
}

function auditReason(reason) {
  return AUDIT_REASONS.has(reason) ? reason : 'USE_FAILED'
}

function valueContext(secret) {
  return Buffer.from(JSON.stringify([secret.id, secret.ownerId, secret.workspaceId, secret.version]))
}

function encryptValue(value, secret, key) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(valueContext(secret))
  return { algorithm: 'aes-256-gcm', iv: iv.toString('base64url'),
    ciphertext: Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }
}

function decryptValue(secret, key) {
  try {
    const { iv, ciphertext, tag } = secret.encryptedValue
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    decipher.setAAD(valueContext(secret))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
  } catch { fail('VAULT_DECRYPT_FAILED', '凭据无法解密，请检查服务器凭据主密钥', 500) }
}

function masterKey(data) {
  const external = process.env.TIE_VAULT_KEY_FILE?.trim()
  const file = external ? path.resolve(external) : path.join(store.root, '.private', 'vault.key')
  if (!fs.existsSync(file)) {
    if (external || data.secrets.length) fail('VAULT_KEY_MISSING', '服务器凭据主密钥不存在', 500)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    assertKeyOutsideWorkspace(path.join(fs.realpathSync(path.dirname(file)), path.basename(file)))
    fs.chmodSync(path.dirname(file), 0o700)
    try {
      fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' })
      fs.chmodSync(file, 0o600)
    }
    catch (error) { if (error.code !== 'EEXIST') fail('VAULT_KEY_UNAVAILABLE', '无法创建服务器凭据主密钥', 500) }
  }
  const resolved = fs.realpathSync(file)
  assertKeyOutsideWorkspace(resolved)
  const stat = fs.statSync(file)
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) fail('VAULT_KEY_PERMISSIONS', '凭据主密钥须为仅当前用户可读的私有文件', 500)
  const bytes = fs.readFileSync(file)
  if (bytes.length === 32) return bytes
  const text = bytes.toString('utf8').trim()
  const decoded = /^[a-fA-F0-9]{64}$/.test(text) ? Buffer.from(text, 'hex')
    : /^[A-Za-z0-9+/_-]{43}=?$/.test(text) ? Buffer.from(text, 'base64') : null
  if (!decoded || decoded.length !== 32) fail('VAULT_KEY_INVALID', '凭据主密钥须为 32 字节随机密钥', 500)
  return decoded
}

function assertKeyOutsideWorkspace(file) {
  const directory = path.resolve(store.root, 'workspaces')
  const workspaces = fs.existsSync(directory) ? fs.realpathSync(directory) : directory
  if (file === workspaces || file.startsWith(workspaces + path.sep)) fail('VAULT_KEY_IN_WORKSPACE', '凭据主密钥不能保存在工作区目录中', 500)
}

function readVault() {
  const file = path.join(store.root, 'vault.json')
  if (!fs.existsSync(file)) return { schemaVersion: 1, secrets: [], grants: [], usage: [] }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data.schemaVersion !== 1 || !Array.isArray(data.secrets) || !Array.isArray(data.grants) || !Array.isArray(data.usage)) throw new Error('invalid vault')
    return data
  } catch { fail('VAULT_STORE_INVALID', '服务器凭据数据无法读取', 500) }
}

function writeVault(data) {
  fs.mkdirSync(store.root, { recursive: true })
  const file = path.join(store.root, 'vault.json')
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' })
    fs.chmodSync(temporary, 0o600)
    fs.renameSync(temporary, file)
  } catch { fail('VAULT_STORE_UNAVAILABLE', '服务器凭据数据无法保存', 500) }
  finally { if (fs.existsSync(temporary)) fs.rmSync(temporary) }
}

function vaultError(code, message, status) { return Object.assign(new Error(message), { code, status }) }
function fail(code, message, status) { throw vaultError(code, message, status) }
