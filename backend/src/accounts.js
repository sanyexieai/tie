import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { store } from './store.js'

export function nowIso() {
  return new Date().toISOString()
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export function userRole(user) {
  return user?.role === 'admin' ? 'admin' : 'user'
}

/** 登录只认一个标识：邮箱，或唯一的用户名（显示名称）。 */
export function findUserByLogin(users, identifier) {
  const folded = String(identifier ?? '').trim().toLowerCase()
  if (!folded) return { user: null, reason: 'empty' }
  const byEmail = users.find((item) => String(item.email ?? '').trim().toLowerCase() === folded)
  if (byEmail) return { user: byEmail, reason: 'email' }
  const byName = users.filter((item) => String(item.name ?? '').trim().toLowerCase() === folded)
  if (byName.length === 1) return { user: byName[0], reason: 'name' }
  if (byName.length > 1) return { user: null, reason: 'ambiguous' }
  return { user: null, reason: 'missing' }
}

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: userRole(user),
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
  }
}

export function signAccessToken(user, jwtSecret) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: userRole(user) },
    jwtSecret,
    { expiresIn: '30d' },
  )
}

export function enabledAdmins(users = store.loadUsers()) {
  return users.filter((item) => userRole(item) === 'admin' && !item.disabled)
}

/** 库里还没有用户时，第一个注册的人是管理员。 */
export function roleForNewUser(users) {
  return users.length === 0 ? 'admin' : 'user'
}
