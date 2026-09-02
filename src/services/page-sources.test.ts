import { describe, expect, it } from 'vitest'
import type { Page } from '@/types'
import { mergePageSourceIds, mergePagesById, normalizePageSources, pageBoundToSource, pageCloudSourceIds, pageContentEqual, pageForStorageWrite, pageMirrorSourceIds, pageSourceIds, pageSourceRoleLabel, prunePageSources, remapPageSourceIds, resolveCollaborationPrimary, sourceShortLabel, withPageSources } from '@/services/page-sources'

function page(partial: Partial<Page> & Pick<Page, 'id' | 'storageSourceId'>): Page {
  return {
    title: 't',
    icon: '',
    parentId: null,
    sortKey: 0,
    markdown: '# t\n',
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...partial,
  }
}

describe('page-sources', () => {
  it('normalizes primary into storageSourceIds', () => {
    const normalized = normalizePageSources(page({ id: 'a', storageSourceId: 's1' }))
    expect(normalized.storageSourceIds).toEqual(['s1'])
    expect(pageSourceIds(normalized)).toEqual(['s1'])
  })

  it('merges duplicate ids across sources', () => {
    const merged = mergePagesById([
      page({ id: 'a', storageSourceId: 's1', updatedAt: '2026-01-01T00:00:00.000Z', title: 'old' }),
      page({ id: 'a', storageSourceId: 's2', updatedAt: '2026-01-02T00:00:00.000Z', title: 'new' }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.title).toBe('new')
    expect(merged[0]?.storageSourceId).toBe('s1')
    expect(pageSourceIds(merged[0]!).sort()).toEqual(['s1', 's2'])
    expect(pageBoundToSource(merged[0]!, 's1')).toBe(true)
  })

  it('pageMirrorSourceIds excludes primary', () => {
    const next = withPageSources(page({ id: 'a', storageSourceId: 's1' }), 's1', ['s1', 's2'])
    expect(pageMirrorSourceIds(next)).toEqual(['s2'])
  })

  it('withPageSources keeps primary first among ids', () => {
    const next = withPageSources(page({ id: 'a', storageSourceId: 's1' }), 's2', ['s1', 's2'])
    expect(next.storageSourceId).toBe('s2')
    expect(pageSourceIds(next)).toEqual(['s2', 's1'])
  })

  it('prunePageSources drops unknown source ids', () => {
    const dirty = page({
      id: 'a',
      storageSourceId: 'minio',
      storageSourceIds: ['minio', 'src_local_ghost', 's3:dead'],
    })
    const cleaned = prunePageSources(dirty, ['minio', 'workspace'])
    expect(pageSourceIds(cleaned)).toEqual(['minio'])
    expect(cleaned.storageSourceId).toBe('minio')
  })

  it('mergePageSourceIds keeps only known sources plus sync source', () => {
    const local = page({ id: 'a', storageSourceId: 'minio', storageSourceIds: ['minio'] })
    const remote = page({
      id: 'a',
      storageSourceId: 'minio',
      storageSourceIds: ['minio', 'other-machine-local', 's3:old'],
    })
    expect(mergePageSourceIds(local, remote, {
      knownSourceIds: ['minio', 'workspace'],
      syncSourceId: 'minio',
    })).toEqual(['minio'])
  })

  it('mergePageSourceIds drops remote local ids even if listed', () => {
    const local = page({
      id: 'a',
      storageSourceId: 's3:cloud',
      storageSourceIds: ['s3:cloud', 'src_local_here'],
    })
    const remote = page({
      id: 'a',
      storageSourceId: 's3:cloud',
      storageSourceIds: ['s3:cloud', 'src_local_other'],
    })
    expect(mergePageSourceIds(local, remote, {
      knownSourceIds: ['s3:cloud', 'src_local_here', 'src_local_other'],
      syncSourceId: 's3:cloud',
    }).sort()).toEqual(['s3:cloud', 'src_local_here'].sort())
  })

  it('pageForStorageWrite strips local ids when writing to cloud', () => {
    const local = page({
      id: 'a',
      storageSourceId: 's3:cloud',
      storageSourceIds: ['s3:cloud', 'src_local_here'],
    })
    const written = pageForStorageWrite(local, 's3:cloud')
    expect(pageSourceIds(written)).toEqual(['s3:cloud'])
    expect(pageCloudSourceIds(local)).toEqual(['s3:cloud'])
  })

  it('pageForStorageWrite keeps local bindings when writing to local', () => {
    const local = page({
      id: 'a',
      storageSourceId: 'src_local_here',
      storageSourceIds: ['src_local_here', 's3:cloud'],
    })
    const written = pageForStorageWrite(local, 'src_local_here')
    expect(written.storageSourceId).toBe('s3:cloud')
    expect(pageSourceIds(written).sort()).toEqual(['s3:cloud', 'src_local_here'].sort())
  })

  it('resolveCollaborationPrimary prefers cloud over local', () => {
    expect(resolveCollaborationPrimary(['src_local_a', 's3:cloud'], 'src_local_a')).toBe('s3:cloud')
    expect(resolveCollaborationPrimary(['src_local_a', 's3:cloud'], 's3:cloud')).toBe('s3:cloud')
    expect(resolveCollaborationPrimary(['src_local_a'], 'src_local_a')).toBe('src_local_a')
  })

  it('pageSourceRoleLabel only marks cloud primary', () => {
    const mixed = page({
      id: 'a',
      storageSourceId: 's3:cloud',
      storageSourceIds: ['s3:cloud', 'src_local_here'],
    })
    expect(pageSourceRoleLabel(mixed, 's3:cloud')).toBe('primary')
    expect(pageSourceRoleLabel(mixed, 'src_local_here')).toBe('mirror')
  })

  it('remapPageSourceIds rewrites legacy s3 ids', () => {
    const dirty = page({
      id: 'a',
      storageSourceId: 's3:old-uuid',
      storageSourceIds: ['s3:old-uuid', 'src_local_here'],
    })
    const next = remapPageSourceIds(dirty, new Map([['s3:old-uuid', 's3:stable']]))
    expect(next.storageSourceId).toBe('s3:stable')
    expect(pageSourceIds(next).sort()).toEqual(['s3:stable', 'src_local_here'].sort())
  })

  it('sourceShortLabel uses the first character', () => {
    expect(sourceShortLabel('工作区 A')).toBe('工')
    expect(sourceShortLabel('Notes')).toBe('N')
    expect(sourceShortLabel('  ')).toBe('?')
  })

  it('pageContentEqual ignores trailing blank lines', () => {
    const a = page({ id: 'a', storageSourceId: 's1', markdown: '# hi\n' })
    const b = page({ id: 'a', storageSourceId: 's1', markdown: '# hi\n\n\n' })
    expect(pageContentEqual(a, b)).toBe(true)
    expect(pageContentEqual(a, page({ id: 'a', storageSourceId: 's1', markdown: '# bye\n' }))).toBe(false)
  })
})
