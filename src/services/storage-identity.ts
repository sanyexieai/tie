/** 云端协作源 vs 本机源：只有云端需要跨端同步与稳定 id。 */

export function isCloudStorageSourceId(sourceId: string | null | undefined) {
  const id = sourceId?.trim() ?? ''
  return id.startsWith('s3:')
    || id.startsWith('backend:')
    || id.startsWith('backend-s3:')
}

export function isLocalStorageSourceId(sourceId: string | null | undefined) {
  const id = sourceId?.trim() ?? ''
  return Boolean(id) && !isCloudStorageSourceId(id)
}

/** 规范化后参与指纹，保证同 endpoint+bucket 跨机同 id。 */
export function normalizeS3Endpoint(endpoint: string) {
  return endpoint.trim().replace(/\/+$/, '').toLowerCase()
}

export function normalizeS3Bucket(bucket: string) {
  return bucket.trim().toLowerCase()
}

/** FNV-1a 64-bit，与 Rust `s3_provider_fingerprint` 保持一致（按 UTF-8 字节）。 */
export function fnv1a64Hex(input: string) {
  const bytes = new TextEncoder().encode(input)
  let hash = 0xcbf29ce484222325n
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

/** S3/MinIO provider 稳定 id（不含 `s3:` 前缀）。 */
export function s3ProviderIdFromEndpointBucket(endpoint: string, bucket: string) {
  const material = `${normalizeS3Endpoint(endpoint)}\0${normalizeS3Bucket(bucket)}`
  return fnv1a64Hex(material)
}

export function looksLikeLegacyS3ProviderId(providerId: string) {
  const id = providerId.trim()
  if (!id) return false
  // 旧版 crypto.randomUUID()；新版为 16 位十六进制指纹。
  return !/^[0-9a-f]{16}$/i.test(id)
}
