import crypto from 'node:crypto'
import { store } from './store.js'

export function hashMcpToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

export function createMcpToken({ userId, name, workspaceId }) {
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
  }
}

export function listMcpTokens(userId) {
  return store.loadMcpTokens().filter((item) => item.userId === userId).map(publicMcpToken)
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
