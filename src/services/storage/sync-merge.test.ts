import { describe, expect, it } from 'vitest'
import type { Page } from '@/types'
import { mergeSyncPages, isLocalWinningConflict } from '@/services/storage/sync-merge'

function page(id: string, sourceId: string, updatedAt: string, markdown: string): Page {
  return {
    id,
    storageSourceId: sourceId,
    title: id,
    icon: '',
    markdown,
    tags: [],
    parentId: null,
    sortKey: 0,
    createdAt: updatedAt,
    updatedAt,
    deletedAt: null,
  }
}

describe('mergeSyncPages', () => {
  const sourceId = 'file:local'

  it('adds remote-only pages', () => {
    const remote = [page('a', sourceId, '2026-01-02T00:00:00.000Z', '# a')]
    const result = mergeSyncPages(sourceId, [], remote, new Set(['a']))
    expect(result.added).toEqual(['a'])
    expect(result.conflicts).toHaveLength(0)
    expect(result.pages).toHaveLength(1)
  })

  it('records conflict when local is newer with different content', () => {
    const local = [page('a', sourceId, '2026-01-03T00:00:00.000Z', '# local')]
    const remote = [page('a', sourceId, '2026-01-02T00:00:00.000Z', '# remote')]
    const result = mergeSyncPages(sourceId, local, remote, new Set(['a']))
    expect(result.conflicts).toHaveLength(1)
    expect(result.pages[0]?.markdown).toBe('# local')
  })

  it('prefers remote when remote is newer with different content', () => {
    const local = [page('a', sourceId, '2026-01-01T00:00:00.000Z', '# local')]
    const remote = [page('a', sourceId, '2026-01-03T00:00:00.000Z', '# remote')]
    const result = mergeSyncPages(sourceId, local, remote, new Set(['a']))
    expect(result.conflicts).toHaveLength(1)
    expect(result.updated).toEqual(['a'])
    expect(result.pages[0]?.markdown).toBe('# remote')
  })

  it('treats identical timestamps and markdown as unchanged', () => {
    const stamp = '2026-01-02T00:00:00.000Z'
    const local = [page('a', sourceId, stamp, '# same')]
    const remote = [page('a', sourceId, stamp, '# same')]
    const result = mergeSyncPages(sourceId, local, remote, new Set(['a']))
    expect(result.unchanged).toBe(1)
    expect(result.conflicts).toHaveLength(0)
  })

  it('identifies local-winning conflicts', () => {
    expect(isLocalWinningConflict({
      pageId: 'a',
      localUpdatedAt: '2026-01-03T00:00:00.000Z',
      remoteUpdatedAt: '2026-01-02T00:00:00.000Z',
    })).toBe(true)
    expect(isLocalWinningConflict({
      pageId: 'a',
      localUpdatedAt: '2026-01-01T00:00:00.000Z',
      remoteUpdatedAt: '2026-01-03T00:00:00.000Z',
    })).toBe(false)
  })
})
