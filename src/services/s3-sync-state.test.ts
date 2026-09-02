import { describe, expect, it } from 'vitest'
import { pageIdsMissingFromResult, pageIdsNeedingDownload, type S3PageIndexEntry, type S3ProviderSyncState } from '@/services/s3-sync-state'

describe('s3-sync-state', () => {
  const index: S3PageIndexEntry[] = [
    { pageId: 'a', etag: '1', lastModified: 't1' },
    { pageId: 'b', etag: '2', lastModified: 't2' },
    { pageId: 'c', etag: '3', lastModified: 't3' },
  ]

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
})
