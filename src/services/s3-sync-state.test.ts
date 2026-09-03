import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  invalidateS3PageSyncState,
  loadS3SyncState,
  pageIdsMissingFromResult,
  pageIdsNeedingDownload,
  saveS3SyncState,
  type S3PageIndexEntry,
  type S3ProviderSyncState,
} from '@/services/s3-sync-state'

class MemoryStorage {
  private store = new Map<string, string>()
  getItem(key: string) { return this.store.get(key) ?? null }
  setItem(key: string, value: string) { this.store.set(key, value) }
  removeItem(key: string) { this.store.delete(key) }
  clear() { this.store.clear() }
}

describe('s3-sync-state', () => {
  const index: S3PageIndexEntry[] = [
    { pageId: 'a', etag: '1', lastModified: 't1' },
    { pageId: 'b', etag: '2', lastModified: 't2' },
    { pageId: 'c', etag: '3', lastModified: 't3' },
  ]

  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
  })

  it('pageIdsNeedingDownload returns all when never synced', () => {
    const cached: S3ProviderSyncState = { objects: {}, lastSyncAt: null }
    expect(pageIdsNeedingDownload(index, cached)).toEqual(['a', 'b', 'c'])
  })

  it('pageIdsNeedingDownload skips unchanged etags', () => {
    const cached: S3ProviderSyncState = {
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      objects: {
        a: { etag: '1', lastModified: 't1' },
        b: { etag: 'old', lastModified: 't2' },
        c: { etag: '3', lastModified: 't3' },
      },
    }
    expect(pageIdsNeedingDownload(index, cached)).toEqual(['b'])
  })

  it('pageIdsMissingFromResult finds cold-start gaps', () => {
    expect(pageIdsMissingFromResult(index, ['a'])).toEqual(['b', 'c'])
    expect(pageIdsMissingFromResult(index, new Set(['a', 'b', 'c']))).toEqual([])
  })

  it('invalidateS3PageSyncState drops one page so next sync re-downloads', () => {
    const providerId = 'prov-test'
    saveS3SyncState(providerId, {
      lastSyncAt: '2026-01-01T00:00:00.000Z',
      objects: {
        a: { etag: '1', lastModified: 't1' },
        b: { etag: '2', lastModified: 't2' },
      },
    })
    invalidateS3PageSyncState(providerId, 'a')
    const state = loadS3SyncState(providerId)
    expect(state.objects.a).toBeUndefined()
    expect(state.objects.b).toEqual({ etag: '2', lastModified: 't2' })
    expect(pageIdsNeedingDownload(index, state)).toEqual(['a', 'c'])
  })
})
