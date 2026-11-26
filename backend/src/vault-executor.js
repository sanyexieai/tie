import { lookup as dnsLookup } from 'node:dns/promises'
import { Agent, request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
const AUTH_TYPES = new Set(['bearer', 'header', 'basic'])
const TARGET_KEYS = new Set(['url', 'method', 'authType', 'headerName', 'username', 'body', 'responseFields'])
const RESERVED_HEADERS = new Set(['host', 'cookie', 'set-cookie', 'content-length', 'content-type', 'connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'origin', 'referer', 'forwarded'])
const SENSITIVE_FIELD = /password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|credential|jwt|session/i
const PROTOTYPE_FIELDS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_RESPONSE_BYTES = 64 * 1024
const TIMEOUT_MS = 10_000

function addresses(subnets) {
  const list = new BlockList()
  for (const [address, prefix, family] of subnets) list.addSubnet(address, prefix, family)
  return list
}

const PRIVATE = addresses([
  ['10.0.0.0', 8, 'ipv4'], ['127.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'],
])
const FORBIDDEN = addresses([
  ['0.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'], ['192.88.99.0', 24, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'], ['fd00:ec2::254', 128, 'ipv6'],
  ['2001::', 23, 'ipv6'], ['2001:db8::', 32, 'ipv6'], ['2002::', 16, 'ipv6'], ['3fff::', 20, 'ipv6'],
])
const GLOBAL_IPV6 = addresses([['2000::', 3, 'ipv6']])

function invalidTarget() {
  return Object.assign(new Error('凭据执行目标配置无效'), { status: 400, code: 'INVALID_TARGET' })
}

export function validateTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !TARGET_KEYS.has(key))) throw invalidTarget()
  if (typeof input.url !== 'string' || input.url.length > 4096 || input.url.includes('#')) throw invalidTarget()
  let url
  try { url = new URL(input.url) } catch { throw invalidTarget() }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) throw invalidTarget()
  const method = typeof (input.method ?? 'GET') === 'string' ? (input.method ?? 'GET').toUpperCase() : ''
  const authType = input.authType ?? 'bearer'
  if (!METHODS.has(method) || !AUTH_TYPES.has(authType)) throw invalidTarget()
  const target = { url: url.href, method, authType }
  if (authType === 'header') {
    if (typeof input.headerName !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(input.headerName)) throw invalidTarget()
    const name = input.headerName.toLowerCase()
    if (RESERVED_HEADERS.has(name) || name.startsWith('proxy-') || name.startsWith('sec-') || name.startsWith('x-forwarded-')) throw invalidTarget()
    target.headerName = name
  } else if (input.headerName !== undefined) throw invalidTarget()
  if (authType === 'basic') {
    if (typeof input.username !== 'string' || input.username.length > 256 || /[:\x00-\x1f\x7f]/.test(input.username)) throw invalidTarget()
    target.username = input.username
  } else if (input.username !== undefined) throw invalidTarget()
  if (input.body !== undefined) {
    if (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 16 * 1024 || method === 'GET' || method === 'HEAD') throw invalidTarget()
    target.body = input.body
  }
  if (input.responseFields !== undefined) {
    if (!Array.isArray(input.responseFields) || input.responseFields.length > 16) throw invalidTarget()
    for (const path of input.responseFields) {
      if (typeof path !== 'string' || path.length > 160) throw invalidTarget()
      const parts = path.split('.')
      if (parts.length > 8 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part) || PROTOTYPE_FIELDS.has(part) || SENSITIVE_FIELD.test(part))) throw invalidTarget()
    }
    if (input.responseFields.length) target.responseFields = [...new Set(input.responseFields)]
  }
  return target
}

function executionError(code) {
  const messages = {
    TARGET_NOT_ALLOWED: '凭据执行目标不在允许的地址范围',
    TARGET_DNS: '无法解析凭据执行目标',
    TARGET_POLICY: '凭据执行地址策略配置无效',
    TARGET_TIMEOUT: '凭据执行目标响应超时',
    TARGET_REDIRECT: '凭据执行目标不允许重定向',
    TARGET_TOO_LARGE: '凭据执行目标响应超过限制',
    TARGET_UNAVAILABLE: '凭据执行目标连接失败',
    TARGET_CREDENTIAL: '凭据不适用于所选认证方式',
  }
  return Object.assign(new Error(messages[code]), { status: code === 'TARGET_NOT_ALLOWED' ? 403 : code === 'TARGET_TIMEOUT' ? 504 : 502, code })
}

function privateOriginAllowed(origin) {
  const configured = (process.env.TIE_VAULT_ALLOWED_ORIGINS || '').split(/[,\s]+/).filter(Boolean)
  const origins = configured.map((entry) => {
    let url
    try { url = new URL(entry) } catch { throw executionError('TARGET_POLICY') }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw executionError('TARGET_POLICY')
    return url.origin
  })
  return origins.includes(origin)
}

async function approvedAddress(url, resolve) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const literalFamily = isIP(hostname)
  let results
  try { results = literalFamily ? [{ address: hostname, family: literalFamily }] : await resolve(hostname, { all: true, verbatim: true }) }
  catch { throw executionError('TARGET_DNS') }
  const allowPrivate = privateOriginAllowed(url.origin)
  if (!Array.isArray(results) || !results.length) throw executionError('TARGET_DNS')
  for (const item of results) {
    const family = isIP(item.address)
    const type = family === 4 ? 'ipv4' : 'ipv6'
    if (!family || family !== item.family || FORBIDDEN.check(item.address, type)) throw executionError('TARGET_NOT_ALLOWED')
    if (PRIVATE.check(item.address, type)) {
      if (!allowPrivate) throw executionError('TARGET_NOT_ALLOWED')
    } else if (family === 6 && !GLOBAL_IPV6.check(item.address, type)) throw executionError('TARGET_NOT_ALLOWED')
  }
  return results.find((item) => item.family === 4) || results[0]
}

function authentication(target, value) {
  if (typeof value !== 'string' || !value || value.length > 64 * 1024) throw executionError('TARGET_CREDENTIAL')
  const header = target.authType === 'basic' ? `Basic ${Buffer.from(`${target.username}:${value}`).toString('base64')}`
    : target.authType === 'bearer' ? `Bearer ${value}` : value
  if (/[\x00-\x1f\x7f]/.test(header)) throw executionError('TARGET_CREDENTIAL')
  return { name: target.authType === 'header' ? target.headerName : 'authorization', header }
}

function selectedFields(body, paths, value, authHeader) {
  let json
  try { json = JSON.parse(body.toString('utf8')) } catch { return undefined }
  const variants = [...new Set([value, authHeader].flatMap((text) => [
    text, encodeURIComponent(Buffer.from(text).toString('utf8')), Buffer.from(text).toString('base64'), Buffer.from(text).toString('base64url'), JSON.stringify(text).slice(1, -1),
  ]))]
  const fields = {}
  for (const path of paths) {
    let scalar = json
    for (const part of path.split('.')) scalar = scalar !== null && typeof scalar === 'object' && Object.hasOwn(scalar, part) ? scalar[part] : undefined
    if (scalar !== null && !['string', 'number', 'boolean'].includes(typeof scalar)) continue
    if (typeof scalar === 'number' && !Number.isFinite(scalar)) continue
    if (typeof scalar === 'string' && scalar.length > 256) continue
    const text = String(scalar)
    let decoded = text
    try { decoded = decodeURIComponent(text) } catch { /* Plain text is still checked below. */ }
    if (variants.some((variant) => text.includes(variant) || decoded.includes(variant))) continue
    fields[path] = scalar
  }
  return Object.keys(fields).length ? fields : undefined
}

// The second parameter is internal test plumbing; HTTP/MCP callers never supply it.
export async function executeCredential({ target, value }, internal = {}) {
  const url = new URL(target.url)
  const auth = authentication(target, value)
  return new Promise((resolve, reject) => {
    let request
    let response
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      response?.destroy()
      request?.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    const timer = setTimeout(() => finish(executionError('TARGET_TIMEOUT')), Math.min(internal.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS))
    approvedAddress(url, internal.resolve ?? dnsLookup).then((address) => {
      if (settled) return
      const hostname = url.hostname.replace(/^\[|\]$/g, '')
      const headers = { accept: 'application/json', [auth.name]: auth.header }
      if (target.body !== undefined) {
        headers['content-type'] = 'application/json; charset=utf-8'
        headers['content-length'] = Buffer.byteLength(target.body)
      }
      try {
        request = httpsRequest({
          protocol: 'https:', hostname, port: url.port || 443, path: url.pathname + url.search,
          method: target.method, headers, agent: new Agent({ keepAlive: false }),
          family: address.family, autoSelectFamily: false, rejectUnauthorized: true,
          ...(internal.ca === undefined ? {} : { ca: internal.ca }),
          lookup: (_hostname, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family),
        }, (incoming) => {
          response = incoming
          const httpStatus = incoming.statusCode
          if (httpStatus >= 300 && httpStatus < 400) return finish(executionError('TARGET_REDIRECT'))
          let size = 0
          const chunks = []
          incoming.on('data', (chunk) => {
            size += chunk.length
            if (size > MAX_RESPONSE_BYTES) return finish(executionError('TARGET_TOO_LARGE'))
            if (target.responseFields?.length) chunks.push(chunk)
          })
          incoming.on('error', () => finish(executionError('TARGET_UNAVAILABLE')))
          incoming.on('end', () => {
            const result = { httpStatus }
            if (target.responseFields?.length) {
              const fields = selectedFields(Buffer.concat(chunks), target.responseFields, value, auth.header)
              if (fields) result.fields = fields
            }
            finish(null, result)
          })
        })
        request.on('error', () => finish(executionError('TARGET_UNAVAILABLE')))
        request.on('upgrade', (_response, socket) => {
          socket.destroy()
          finish(executionError('TARGET_UNAVAILABLE'))
        })
        request.end(target.body)
      } catch { finish(executionError('TARGET_UNAVAILABLE')) }
    }).catch((error) => finish(error?.code?.startsWith('TARGET_') ? error : executionError('TARGET_UNAVAILABLE')))
  })
}
