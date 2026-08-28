import path from 'node:path'

const MAX_ASSET_BYTES = 20 * 1024 * 1024

export function sanitizeAssetName(fileName) {
  const base = path.basename(String(fileName ?? ''))
  if (!base || base === '.' || base === '..' || !/^[a-zA-Z0-9._-]+$/.test(base)) {
    const error = new Error('附件名称无效')
    error.status = 400
    throw error
  }
  return base
}

export function mimeFromAssetName(assetName) {
  const extension = assetName.split('.').pop()?.toLowerCase()
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'svg') return 'image/svg+xml'
  return 'application/octet-stream'
}

export function assertAssetPayload(data) {
  if (!data || !data.length) {
    const error = new Error('附件内容为空')
    error.status = 400
    throw error
  }
  if (data.length > MAX_ASSET_BYTES) {
    const error = new Error('附件超过 20 MB')
    error.status = 413
    throw error
  }
}
