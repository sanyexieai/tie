import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { nowIso, publicUser, userRole } from './accounts.js'
import { store } from './store.js'

const ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60
const REFRESH_TTL_MS = 365 * 24 * 60 * 60 * 1000

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function sameHash(token, expected) {
  if (!expected || expected.length !== 64) return false
  const actual = Buffer.from(hashToken(token), 'hex')
  const stored = Buffer.from(expected, 'hex')
  return actual.length === stored.length && crypto.timingSafeEqual(actual, stored)
}

function liveSessions() {
  const now = nowIso()
  return store.loadSessions().filter((item) => item && item.expiresAt > now)
}

function accessTokenFor(user, sessionId, jwtSecret) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: userRole(user), sid: sessionId, jti: crypto.randomUUID() },
    jwtSecret,
    { expiresIn: ACCESS_TTL_SECONDS },
  )
}

function bundle(user, sessionId, refreshToken, jwtSecret) {
  const accessToken = accessTokenFor(user, sessionId, jwtSecret)
  const decoded = jwt.decode(accessToken)
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: new Date(Number(decoded?.exp ?? 0) * 1000).toISOString(),
    tokenType: 'Bearer',
    user: publicUser(user),
  }
}

export function issueSession(user, jwtSecret) {
  const refreshToken = crypto.randomBytes(32).toString('base64url')
  const session = {
    id: `ses_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    userId: user.id,
    refreshHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
  }
  const sessions = liveSessions()
  sessions.push(session)
  store.saveSessions(sessions)
  return bundle(user, session.id, refreshToken, jwtSecret)
}

export function rotateSession(refreshToken, jwtSecret) {
  const token = String(refreshToken ?? '')
  const sessions = liveSessions()
  const current = sessions.find((item) => sameHash(token, item.refreshHash))
  if (!current) {
    const error = new Error('登录已失效，请重新登录')
    error.status = 401
    throw error
  }
  const user = store.loadUsers().find((item) => item.id === current.userId)
  if (!user || user.disabled) {
    store.saveSessions(sessions.filter((item) => item.id !== current.id))
    const error = new Error(user?.disabled ? '账号已停用' : '登录已失效，请重新登录')
    error.status = user?.disabled ? 403 : 401
    throw error
  }
  const nextRefresh = crypto.randomBytes(32).toString('base64url')
  current.refreshHash = hashToken(nextRefresh)
  current.expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString()
  store.saveSessions(sessions)
  return bundle(user, current.id, nextRefresh, jwtSecret)
}

export function revokeSession(refreshToken) {
  const token = String(refreshToken ?? '')
  if (!token) return
  store.saveSessions(liveSessions().filter((item) => !sameHash(token, item.refreshHash)))
}
