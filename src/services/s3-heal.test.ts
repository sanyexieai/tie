import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page } from '@/types'
import { remapPageSourceIds } from '@/services/page-sources'
import {
  buildS3SourceIdHealingRemap,
  saveLocalS3ProvidersAsync,
  type LocalS3Provider,
} from '@/services/s3'

class MemoryStorage {
  private store = new Map<string, string>()
  getItem(key: string) { return this.store.get(key) ?? null }
  setItem(key: string, value: string) { this.store.set(key, value) }
  removeItem(key: string) { this.store.delete(key) }
  clear() { this.store.clear() }
}

function page(id: string, storageSourceId: string): Page {
  return {
    id,
    title: id,
    icon: '',
    parentId: null,
    sortKey: 0,
    markdown: '# t\n',
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    storageSourceId,
    storageSourceIds: [storageSourceId],
  }
}

describe('buildS3SourceIdHealingRemap', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps unknown legacy s3 uuid to the sole provider fingerprint', async () => {
    const provider: LocalS3Provider = {
      id: '248d6286-f69f-4dab-8870-583d92f3529c',
      name: 'minio',
      endpoint: 'http://example.com:9000',
      bucket: 'tie',
      credentialStored: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    await saveLocalS3ProvidersAsync([provider])

    const dirty = page('a', 's3:248d6286-f69f-4dab-8870-583d92f3529c')
    const remap = buildS3SourceIdHealingRemap([dirty])
    const target = [...remap.values()][0]
    expect(target).toMatch(/^s3:[0-9a-f]{16}$/)
    expect(remap.get(dirty.storageSourceId)).toBe(target)
    expect(remapPageSourceIds(dirty, remap).storageSourceId).toBe(target)
  })
})
