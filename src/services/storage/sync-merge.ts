import type { Page } from '@/types'
import type { SyncConflict, SyncResult } from '@/services/storage/types'

export function emptySyncResult(sourceId: string, error?: string): SyncResult {
  return {
    sourceId,
    pages: [],
    added: [],
    updated: [],
    removed: [],
    conflicts: [],
    unchanged: 0,
    error,
  }
}

export function isLocalWinningConflict(conflict: SyncConflict) {
  return conflict.localUpdatedAt > conflict.remoteUpdatedAt
}

export function mergeSyncPages(
  sourceId: string,
  localPages: Page[],
  remotePages: Page[],
  remoteIds: Set<string>,
): SyncResult {
  const scopedLocal = localPages.filter((page) => page.storageSourceId === sourceId)
  const localById = new Map(scopedLocal.map((page) => [page.id, page]))
  const remoteById = new Map(remotePages.map((page) => [page.id, page]))
  const added: string[] = []
  const updated: string[] = []
  const removed: string[] = []
  const conflicts: SyncConflict[] = []
  const merged: Page[] = []
  let unchanged = 0

  remoteById.forEach((remote, pageId) => {
    const local = localById.get(pageId)
    if (!local) {
      added.push(pageId)
      merged.push(remote)
      return
    }
    if (local.updatedAt === remote.updatedAt && local.markdown === remote.markdown) {
      unchanged += 1
      merged.push(local)
      return
    }
    if (local.updatedAt > remote.updatedAt && local.markdown !== remote.markdown) {
      conflicts.push({
        pageId,
        localUpdatedAt: local.updatedAt,
        remoteUpdatedAt: remote.updatedAt,
      })
      merged.push(local)
      return
    }
    if (local.updatedAt < remote.updatedAt && local.markdown !== remote.markdown) {
      conflicts.push({
        pageId,
        localUpdatedAt: local.updatedAt,
        remoteUpdatedAt: remote.updatedAt,
      })
    }
    updated.push(pageId)
    merged.push(remote)
  })

  scopedLocal.forEach((page) => {
    if (!remoteIds.has(page.id)) removed.push(page.id)
  })

  return {
    sourceId,
    pages: merged,
    added,
    updated,
    removed,
    conflicts,
    unchanged,
  }
}
