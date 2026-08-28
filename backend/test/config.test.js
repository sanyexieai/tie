import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  DEFAULT_JWT_SECRET,
  assertProductionReady,
  resolveBindHost,
  validateJwtSecret,
} from '../src/config.js'

const envBackup = { ...process.env }

afterEach(() => {
  process.env = { ...envBackup }
})

describe('backend config', { concurrency: 1 }, () => {
  it('allows weak secrets in test mode', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.TIE_ALLOW_WEAK_SECRET
    assert.equal(validateJwtSecret(DEFAULT_JWT_SECRET), DEFAULT_JWT_SECRET)
  })

  it('rejects default secret in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.TIE_ALLOW_WEAK_SECRET = '0'
    process.env.TIE_JWT_SECRET = DEFAULT_JWT_SECRET
    assert.throws(
      () => validateJwtSecret(DEFAULT_JWT_SECRET),
      /不得使用默认或弱 JWT 密钥/,
    )
  })

  it('requires long custom secret in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.TIE_ALLOW_WEAK_SECRET = '0'
    process.env.TIE_JWT_SECRET = 'short-secret'
    assert.throws(
      () => assertProductionReady({ jwtSecret: process.env.TIE_JWT_SECRET }),
      /至少需要 32 个字符/,
    )
  })

  it('defaults production bind host to loopback', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.TIE_BIND
    assert.equal(resolveBindHost(), '127.0.0.1')
  })
})
