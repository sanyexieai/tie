import type { Page } from '@/types'
import { pageBoundToSource, pageContentEqual } from '@/services/page-sources'
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
  // 双绑定页面主源可能不是当前同步源，必须按绑定关系纳入比较。
  const scopedLocal = localPages.filter((page) => pageBoundToSource(page, sourceId))
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
    // 正文实质相同（含忽略末尾空行）时绝不报冲突，只收敛到较新时间戳。
    if (pageContentEqual(local, remote)) {
      unchanged += 1
      merged.push(local.updatedAt >= remote.updatedAt ? local : {
        ...remote,
        storageSourceId: local.storageSourceId || remote.storageSourceId,
        storageSourceIds: local.storageSourceIds?.length ? local.storageSourceIds : remote.storageSourceIds,
      })
      return
    }
    if (local.updatedAt > remote.updatedAt) {
      conflicts.push({
        pageId,
        localUpdatedAt: local.updatedAt,
        remoteUpdatedAt: remote.updatedAt,
      })
      merged.push(local)
      return
    }
    if (local.updatedAt < remote.updatedAt) {
      conflicts.push({
        pageId,
        localUpdatedAt: local.updatedAt,
        remoteUpdatedAt: remote.updatedAt,
      })
      updated.push(pageId)
      merged.push(remote)
      return
    }
    // 时间戳相同但正文不同：以远程为准并标冲突，便于编辑器提示。
    conflicts.push({
      pageId,
      localUpdatedAt: local.updatedAt,
      remoteUpdatedAt: remote.updatedAt,
    })
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
