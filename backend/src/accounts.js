import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { verify } from 'argon2'
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

export function normalizeLoginIdentifier(value) {
  return String(value ?? '').trim().toLowerCase()
}

export function assertUniqueUserIdentity(users, candidate, previous = null) {
  const others = users.filter((item) => item.id !== previous?.id)
  const email = normalizeLoginIdentifier(candidate.email)
  const name = normalizeLoginIdentifier(candidate.name)
  const emailChanged = !previous || email !== normalizeLoginIdentifier(previous.email)
  const nameChanged = !previous || name !== normalizeLoginIdentifier(previous.name)
  let message = ''
  if (emailChanged && others.some((item) => normalizeLoginIdentifier(item.email) === email)) message = '邮箱已注册'
  else if (nameChanged && others.some((item) => normalizeLoginIdentifier(item.name) === name)) message = '用户名已存在'
  else if (nameChanged && others.some((item) => normalizeLoginIdentifier(item.email) === name)) message = '用户名与已有账号的邮箱冲突'
  else if (emailChanged && others.some((item) => normalizeLoginIdentifier(item.name) === email)) message = '邮箱与已有账号的用户名冲突'
  if (message) {
    const error = new Error(message)
    error.status = 409
    throw error
  }
}

/** 登录只认一个标识：邮箱，或唯一的用户名（显示名称）。 */
export function findUserByLogin(users, identifier) {
  const folded = normalizeLoginIdentifier(identifier)
  if (!folded) return { user: null, reason: 'empty' }
  const byEmail = users.find((item) => normalizeLoginIdentifier(item.email) === folded)
  if (byEmail) return { user: byEmail, reason: 'email' }
  const byName = users.filter((item) => normalizeLoginIdentifier(item.name) === folded)
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

export async function verifyPassword(password, hash) {
  return hash.startsWith('$argon2') ? verify(hash, password) : bcrypt.compare(password, hash)
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
