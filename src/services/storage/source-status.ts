import { reactive } from 'vue'
import type { SourceRuntimeStatus } from '@/services/storage/types'
import { defaultSourceStatus } from '@/services/storage/types'

const statuses = reactive(new Map<string, SourceRuntimeStatus>())

function ensure(sourceId: string) {
  if (!statuses.has(sourceId)) statuses.set(sourceId, defaultSourceStatus(sourceId))
  return statuses.get(sourceId)!
}

export const sourceStatusStore = {
  get(sourceId: string): SourceRuntimeStatus {
    return statuses.get(sourceId) ?? defaultSourceStatus(sourceId)
  },
  getAll(): SourceRuntimeStatus[] {
    return [...statuses.values()]
  },
  patch(sourceId: string, patch: Partial<Omit<SourceRuntimeStatus, 'sourceId'>>) {
    const current = ensure(sourceId)
    Object.assign(current, patch)
  },
  setLoading(sourceId: string) {
    this.patch(sourceId, { state: 'loading', lastError: null })
  },
  setSyncing(sourceId: string) {
    this.patch(sourceId, { state: 'syncing', lastError: null })
  },
  setSynced(sourceId: string, pagesLoaded = true) {
    this.patch(sourceId, {
      state: 'idle',
      lastSyncedAt: pagesLoaded ? new Date().toISOString() : this.get(sourceId).lastSyncedAt,
      lastError: null,
    })
  },
  setError(sourceId: string, error: string) {
    this.patch(sourceId, { state: 'error', lastError: error })
  },
  setOffline(sourceId: string, error?: string) {
    this.patch(sourceId, { state: 'offline', lastError: error ?? '连接不可用' })
  },
  setQueued(sourceId: string, pendingCount: number) {
    this.patch(sourceId, { state: pendingCount > 0 ? 'queued' : 'idle', pendingCount })
  },
  remove(sourceId: string) {
    statuses.delete(sourceId)
  },
  refreshPendingCounts(counts: Map<string, number>) {
    counts.forEach((pendingCount, sourceId) => this.setQueued(sourceId, pendingCount))
  },
}
