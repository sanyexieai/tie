import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page } from '@/types'
import { syncQueue } from '@/services/storage/sync-queue'

class MemoryStorage {
  private store = new Map<string, string>()

  getItem(key: string) {
    return this.store.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.store.set(key, value)
  }

  removeItem(key: string) {
    this.store.delete(key)
  }

  clear() {
    this.store.clear()
  }
}

function demoPage(id: string, sourceId = 'file:local'): Page {
  const stamp = '2026-01-02T00:00:00.000Z'
  return {
    id,
    title: id,
    icon: '',
    markdown: `# ${id}`,
    tags: [],
    parentId: null,
    sortKey: 0,
    createdAt: stamp,
    updatedAt: stamp,
    deletedAt: null,
    storageSourceId: sourceId,
  }
}

describe('syncQueue', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('deduplicates save entries for the same page', () => {
    const page = demoPage('pg_a')
    syncQueue.enqueueSave(page, '2026-01-01T00:00:00.000Z')
    syncQueue.enqueueSave({ ...page, markdown: '# updated' }, '2026-01-02T00:00:00.000Z')
    const items = syncQueue.list()
    expect(items).toHaveLength(1)
    expect(items[0]?.page.markdown).toBe('# updated')
    expect(items[0]?.expectedUpdatedAt).toBe('2026-01-02T00:00:00.000Z')
  })

  it('tracks pending counts by source', () => {
    syncQueue.enqueueSave(demoPage('pg_a', 'file:a'))
    syncQueue.enqueueSave(demoPage('pg_b', 'file:a'))
    syncQueue.enqueueSave(demoPage('pg_c', 's3:b'))
    expect(syncQueue.count('file:a')).toBe(2)
    expect(syncQueue.count('s3:b')).toBe(1)
    expect(syncQueue.pendingCountsBySource()).toEqual(new Map([
      ['file:a', 2],
      ['s3:b', 1],
    ]))
  })

  it('marks failed items and removes completed ones', () => {
    const item = syncQueue.enqueueSave(demoPage('pg_a'))
    syncQueue.markFailed(item.id, 'network down')
    expect(syncQueue.list()[0]?.lastError).toBe('network down')
    expect(syncQueue.list()[0]?.retryCount).toBe(1)
    syncQueue.remove(item.id)
    expect(syncQueue.list()).toHaveLength(0)
  })
})
