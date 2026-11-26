import crypto from 'node:crypto'
import { store } from './store.js'

export function hashMcpToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

export function createMcpToken({ userId, name, workspaceId }, serverSecret) {
  const token = `tmcp_${crypto.randomBytes(24).toString('base64url')}`
  const record = {
    id: `mtok_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    userId,
    name: String(name || 'MCP').trim() || 'MCP',
    workspaceId,
    tokenHash: hashMcpToken(token),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  }
  record.encryptedToken = encryptMcpToken(token, record, serverSecret)
  const tokens = store.loadMcpTokens()
  tokens.push(record)
  store.saveMcpTokens(tokens)
  return { record: publicMcpToken(record), token }
}

export function publicMcpToken(record) {
  return {
    id: record.id,
    name: record.name,
    workspaceId: record.workspaceId,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    canReveal: Boolean(record.encryptedToken),
  }
}

export function listMcpTokens(userId) {
  return store.loadMcpTokens().filter((item) => item.userId === userId).map(publicMcpToken)
}

export function revealMcpToken(userId, tokenId, serverSecret) {
  const record = store.loadMcpTokens().find((item) => item.id === tokenId && item.userId === userId)
  if (!record) return null
  if (!record.encryptedToken) {
    throw Object.assign(new Error('此旧令牌只保存了不可逆摘要，无法查看。请重新签发新令牌；原令牌仍可继续使用。'), { status: 409 })
  }
  try {
    const { version, iv, ciphertext, tag } = record.encryptedToken
    if (version !== 1) throw new Error('Unsupported token secret version')
    const decipher = crypto.createDecipheriv('aes-256-gcm', tokenEncryptionKey(serverSecret), Buffer.from(iv, 'base64url'))
    decipher.setAAD(tokenSecretContext(record))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    throw Object.assign(new Error('无法解密此令牌，请重新签发新令牌；原令牌仍可继续使用。'), { status: 409 })
  }
}

function tokenEncryptionKey(serverSecret) {
  return crypto.createHmac('sha256', serverSecret).update('tie/backend/mcp-token/stored-secret/v1').digest()
}

function tokenSecretContext(record) {
  return Buffer.from(JSON.stringify([record.id, record.userId, record.workspaceId]))
}

function encryptMcpToken(token, record, serverSecret) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenEncryptionKey(serverSecret), iv)
  cipher.setAAD(tokenSecretContext(record))
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return {
    version: 1,
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  }
}

export function deleteMcpToken(userId, tokenId) {
  const tokens = store.loadMcpTokens()
  const found = tokens.find((item) => item.id === tokenId && item.userId === userId)
  if (!found) return false
  store.saveMcpTokens(tokens.filter((item) => item.id !== tokenId))
  return true
}

export function deleteMcpTokensForUser(userId) {
  store.saveMcpTokens(store.loadMcpTokens().filter((item) => item.userId !== userId))
}

export function deleteMcpTokensForWorkspace(workspaceId) {
  store.saveMcpTokens(store.loadMcpTokens().filter((item) => item.workspaceId !== workspaceId))
}

export function findMcpToken(rawToken) {
  const tokenHash = hashMcpToken(rawToken)
  return store.loadMcpTokens().find((item) => item.tokenHash === tokenHash) ?? null
}

export function touchMcpToken(tokenId) {
  const tokens = store.loadMcpTokens()
  const next = tokens.map((item) => item.id === tokenId ? { ...item, lastUsedAt: new Date().toISOString() } : item)
  store.saveMcpTokens(next)
}
