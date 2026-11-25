export function assertResourceId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    const error = new Error('资源 id 无效')
    error.status = 400
    throw error
  }
  return value
}
