import cors from 'cors'

export const DEFAULT_JWT_SECRET = 'tie-dev-secret-change-me'

export function isProductionMode() {
  return process.env.NODE_ENV === 'production' || process.env.TIE_ENV === 'production'
}

export function allowsWeakSecrets() {
  return process.env.TIE_ALLOW_WEAK_SECRET === '1' || process.env.NODE_ENV === 'test'
}

export function resolveJwtSecret(options = {}) {
  if (options.jwtSecret) return options.jwtSecret
  return process.env.TIE_JWT_SECRET ?? DEFAULT_JWT_SECRET
}

export function validateJwtSecret(secret, { allowWeak = allowsWeakSecrets() } = {}) {
  if (allowWeak) return secret
  if (!isProductionMode()) return secret
  if (!process.env.TIE_JWT_SECRET) {
    throw new Error('生产环境必须设置 TIE_JWT_SECRET')
  }
  const lowered = secret.toLowerCase()
  if (secret === DEFAULT_JWT_SECRET || lowered.includes('change-me') || lowered.includes('dev-secret')) {
    throw new Error('生产环境不得使用默认或弱 JWT 密钥')
  }
  if (!secret || secret.length < 32) {
    throw new Error('生产环境 TIE_JWT_SECRET 至少需要 32 个字符')
  }
  return secret
}

export function assertProductionReady({ jwtSecret }) {
  validateJwtSecret(jwtSecret)
}

export function resolveBindHost() {
  const host = process.env.TIE_BIND?.trim()
  if (host) return host
  return isProductionMode() ? '127.0.0.1' : '0.0.0.0'
}

export function createCorsMiddleware() {
  const raw = process.env.TIE_CORS_ORIGIN?.trim()
  if (!raw) {
    return isProductionMode() ? cors({ origin: false }) : cors()
  }
  if (raw === '*') {
    if (isProductionMode()) {
      console.warn('警告：生产环境使用了 TIE_CORS_ORIGIN=*，仅建议在受控内网使用')
    }
    return cors()
  }
  const origins = raw.split(',').map((item) => item.trim()).filter(Boolean)
  return cors({ origin: origins })
}
