const FIELDS = ['clientId', 'clientName', 'clientVersion', 'deviceId', 'deviceName', 'platform', 'actor']

export function normalizeChangeOrigin(value, defaults = {}) {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
    const error = new Error('客户端来源信息无效')
    error.status = 400
    throw error
  }
  const origin = {}
  for (const field of FIELDS) {
    const text = value?.[field] ?? defaults[field] ?? ''
    if (typeof text !== 'string' || text.length > 240 || /[\r\n\0]/.test(text)) {
      const error = new Error('客户端来源字段无效')
      error.status = 400
      throw error
    }
    origin[field] = text.trim()
  }
  if (!origin.deviceId) origin.deviceName = ''
  if (defaults.userId) origin.userId = defaults.userId
  return origin
}

export function requestChangeOrigin(req, defaults = {}) {
  const header = req.headers?.['x-tie-origin']
  let value
  if (header) {
    try { value = JSON.parse(decodeURIComponent(String(header))) }
    catch {
      const error = new Error('客户端来源头无效')
      error.status = 400
      throw error
    }
  }
  return normalizeChangeOrigin(value, defaults)
}
