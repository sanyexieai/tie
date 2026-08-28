import type { Page } from '@/types'

const QUEUE_KEY = 'tie-sync-queue-v1'

export type SyncQueueOperation = 'save' | 'delete'

export interface SyncQueueItem {
  id: string
  operation: SyncQueueOperation
  sourceId: string
  page: Page
  pageIds?: string[]
  expectedUpdatedAt?: string
  createdAt: string
  retryCount: number
  lastError?: string
}

function readQueue(): SyncQueueItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((item): item is SyncQueueItem => Boolean(
      item && typeof item === 'object'
      && typeof (item as SyncQueueItem).id === 'string'
      && typeof (item as SyncQueueItem).sourceId === 'string',
    )) : []
  } catch {
    return []
  }
}

function writeQueue(items: SyncQueueItem[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items))
}

function queueId() {
  return `sq_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
}

export const syncQueue = {
  list(): SyncQueueItem[] {
    return readQueue()
  },
  count(sourceId?: string) {
    const items = readQueue()
    return sourceId ? items.filter((item) => item.sourceId === sourceId).length : items.length
  },
  pendingCountsBySource() {
    const counts = new Map<string, number>()
    readQueue().forEach((item) => counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1))
    return counts
  },
  enqueueSave(page: Page, expectedUpdatedAt?: string) {
    const items = readQueue().filter((item) => !(item.operation === 'save' && item.page.id === page.id))
    items.push({
      id: queueId(),
      operation: 'save',
      sourceId: page.storageSourceId,
      page,
      expectedUpdatedAt,
      createdAt: new Date().toISOString(),
      retryCount: 0,
    })
    writeQueue(items)
    window.dispatchEvent(new Event('tie:sync-queue-changed'))
    return items[items.length - 1]
  },
  enqueueDelete(sourceId: string, pages: Page[]) {
    const items = readQueue()
    items.push({
      id: queueId(),
      operation: 'delete',
      sourceId,
      page: pages[0],
      pageIds: pages.map((page) => page.id),
      createdAt: new Date().toISOString(),
      retryCount: 0,
    })
    writeQueue(items)
    window.dispatchEvent(new Event('tie:sync-queue-changed'))
  },
  remove(itemId: string) {
    writeQueue(readQueue().filter((item) => item.id !== itemId))
    window.dispatchEvent(new Event('tie:sync-queue-changed'))
  },
  removeForPage(pageId: string) {
    writeQueue(readQueue().filter((item) => item.page.id !== pageId))
    window.dispatchEvent(new Event('tie:sync-queue-changed'))
  },
  markFailed(itemId: string, error: string) {
    writeQueue(readQueue().map((item) => item.id === itemId
      ? { ...item, retryCount: item.retryCount + 1, lastError: error }
      : item))
    window.dispatchEvent(new Event('tie:sync-queue-changed'))
  },
}
