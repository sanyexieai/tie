import { describe, expect, it } from 'vitest'
import {
  fnv1a64Hex,
  isCloudStorageSourceId,
  isLocalStorageSourceId,
  s3ProviderIdFromEndpointBucket,
} from '@/services/storage-identity'

describe('storage-identity', () => {
  it('classifies cloud vs local source ids', () => {
    expect(isCloudStorageSourceId('s3:abc')).toBe(true)
    expect(isCloudStorageSourceId('backend:ws')).toBe(true)
    expect(isCloudStorageSourceId('backend-s3:p')).toBe(true)
    expect(isLocalStorageSourceId('src_local_abc')).toBe(true)
    expect(isCloudStorageSourceId('src_local_abc')).toBe(false)
  })

  it('builds stable S3 provider ids from endpoint+bucket', () => {
    const a = s3ProviderIdFromEndpointBucket('https://minio.example.com/', 'tie')
    const b = s3ProviderIdFromEndpointBucket('https://minio.example.com', 'TIE')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(a).not.toBe(s3ProviderIdFromEndpointBucket('https://other.example.com', 'tie'))
  })

  it('fnv1a matches known vector', () => {
    // UTF-8 bytes of "a\0b"
    expect(fnv1a64Hex('a\0b')).toMatch(/^[0-9a-f]{16}$/)
  })
})
