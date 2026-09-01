import { describe, expect, it } from 'vitest'
import type { Page } from '@/types'
import { mergePagesById, normalizePageSources, pageBoundToSource, pageSourceIds, sourceShortLabel, withPageSources } from '@/services/page-sources'

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
    expect(pageSourceIds(merged[0]!).sort()).toEqual(['s1', 's2'])
    expect(pageBoundToSource(merged[0]!, 's1')).toBe(true)
  })

  it('withPageSources keeps primary first among ids', () => {
    const next = withPageSources(page({ id: 'a', storageSourceId: 's1' }), 's2', ['s1', 's2'])
    expect(next.storageSourceId).toBe('s2')
    expect(pageSourceIds(next)).toEqual(['s2', 's1'])
  })

  it('sourceShortLabel uses the first character', () => {
    expect(sourceShortLabel('工作区 A')).toBe('工')
    expect(sourceShortLabel('Notes')).toBe('N')
    expect(sourceShortLabel('  ')).toBe('?')
  })
})
