import { describe, expect, it } from 'vitest'
import type { Page } from '@/types'
import { reconcileSaveAgainstRemote } from '@/services/save-reconcile'

function page(id: string, updatedAt: string, markdown: string, title = id): Page {
  return {
    id,
    storageSourceId: 'file:local',
    title,
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

describe('reconcileSaveAgainstRemote', () => {
  it('proceeds when remote timestamp matches baseline', () => {
    const baseline = page('a', '2026-01-01T00:00:00.000Z', '# same')
    const draft = page('a', '2026-01-02T00:00:00.000Z', '# edited')
    const remote = page('a', '2026-01-01T00:00:00.000Z', '# same')
    expect(reconcileSaveAgainstRemote(baseline, draft, remote)).toEqual({
      action: 'proceed',
      expectedUpdatedAt: baseline.updatedAt,
    })
  })

  it('adopts remote timestamp when only timestamp changed on disk', () => {
    const baseline = page('a', '2026-01-01T00:00:00.000Z', '# same')
    const draft = page('a', '2026-01-02T00:00:00.000Z', '# edited')
    const remote = page('a', '2026-01-03T00:00:00.000Z', '# same')
    expect(reconcileSaveAgainstRemote(baseline, draft, remote)).toEqual({
      action: 'proceed',
      expectedUpdatedAt: remote.updatedAt,
      adoptRemoteTimestamp: remote.updatedAt,
    })
  })

  it('skips when draft already matches remote', () => {
    const baseline = page('a', '2026-01-01T00:00:00.000Z', '# old')
    const remote = page('a', '2026-01-03T00:00:00.000Z', '# remote')
    const draft = page('a', '2026-01-04T00:00:00.000Z', '# remote')
    expect(reconcileSaveAgainstRemote(baseline, draft, remote)).toEqual({
      action: 'skip',
      page: remote,
    })
  })

  it('conflicts when both sides edited different content', () => {
    const baseline = page('a', '2026-01-01T00:00:00.000Z', '# old')
    const draft = page('a', '2026-01-04T00:00:00.000Z', '# local edit')
    const remote = page('a', '2026-01-03T00:00:00.000Z', '# remote edit')
    expect(reconcileSaveAgainstRemote(baseline, draft, remote)).toEqual({
      action: 'conflict',
      remote,
    })
  })

  it('skips when user did not edit but remote moved forward', () => {
    const baseline = page('a', '2026-01-01T00:00:00.000Z', '# old')
    const draft = page('a', '2026-01-02T00:00:00.000Z', '# old')
    const remote = page('a', '2026-01-03T00:00:00.000Z', '# remote')
    expect(reconcileSaveAgainstRemote(baseline, draft, remote)).toEqual({
      action: 'skip',
      page: remote,
    })
  })
})
