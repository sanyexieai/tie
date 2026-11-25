import { expect, it } from 'vitest'
import type { Page } from '@/types'
import { captureStartupPages, mergeStartupPages } from './startup-pages'

function page(id: string, text = 'original'): Page {
  return { id, title: id, markdown: text, icon: '', tags: [], parentId: null, sortKey: 0,
    storageSourceId: 'local:a', storageSourceIds: ['local:a'],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deletedAt: null }
}

it('keeps live content and metadata edited while a newer background snapshot loads', () => {
  const live = [page('edited'), page('unchanged')]
  const before = captureStartupPages(live)
  live[0]!.markdown = 'typed locally'
  live[0]!.tags.push('user tag')
  live[0]!.parentId = 'chosen-parent'
  const incoming = [page('edited', 'stale read'), page('unchanged', 'remote update')]
  incoming.forEach((item) => { item.updatedAt = '2027-01-01T00:00:00Z' })
  const merged = mergeStartupPages(before, incoming, live)
  expect(merged.find((item) => item.id === 'edited')).toMatchObject({ markdown: 'typed locally', tags: ['user tag'], parentId: 'chosen-parent' })
  expect(merged.find((item) => item.id === 'unchanged')?.markdown).toBe('remote update')
})

it('retains new live pages and does not resurrect pages removed during loading', () => {
  const before = captureStartupPages([page('deleted'), page('kept')])
  const live = [page('kept'), page('new local')]
  const merged = mergeStartupPages(before, [page('deleted'), page('new remote')], live)
  expect(merged.map((item) => item.id)).toEqual(['kept', 'new local', 'new remote'])
})

it('does not reattach a source explicitly removed while a snapshot loads', () => {
  const original = { ...page('moved'), storageSourceId: 's3:old', storageSourceIds: ['local:a', 's3:old'] }
  const before = captureStartupPages([original])
  const now = { ...original, storageSourceId: 'local:a', storageSourceIds: ['local:a'] }
  const merged = mergeStartupPages(before, [original], [now])
  expect(merged[0]?.storageSourceId).toBe('local:a')
  expect(merged[0]?.storageSourceIds).toEqual(['local:a'])
})
