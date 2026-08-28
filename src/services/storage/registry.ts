import { invoke } from '@tauri-apps/api/core'
import type { Page, PageRevision, StorageSource, WorkspaceSnapshot } from '@/types'
import { isBackendRemoteSourceId } from '@/services/backend'
import { copyPageAssets as copyPageAssetsBetweenSources } from '@/services/attachments'
import { canTransferBetweenSources, transferBlockedMessage } from '@/services/transfer-policy'
import { isS3SourceId, s3ConnectionForSource } from '@/services/s3'
import { backendStorageAdapter, loadAllBackendPages } from '@/services/storage/backend-adapter'
import { backendS3StorageAdapter, loadAllBackendS3Pages } from '@/services/storage/backend-s3-adapter'
import { browserStorageAdapter, loadBrowserSnapshot } from '@/services/storage/browser-adapter'
import { fileStorageAdapter } from '@/services/storage/file-adapter'
import { loadAllS3Pages, s3StorageAdapter } from '@/services/storage/s3-adapter'
import { sourceStatusStore } from '@/services/storage/source-status'
import { emptySyncResult, isLocalWinningConflict } from '@/services/storage/sync-merge'
import { syncQueue } from '@/services/storage/sync-queue'
import type { S3ConnectionInput, SavePageOptions, StorageAdapter, SyncResult } from '@/services/storage/types'
import { isFileSourceId } from '@/services/storage/types'

const adapters: StorageAdapter[] = [
  backendStorageAdapter,
  backendS3StorageAdapter,
  s3StorageAdapter,
  browserStorageAdapter,
  fileStorageAdapter,
]

async function isTauri() {
  return '__TAURI_INTERNALS__' in window
}

function applySyncStatus(sourceId: string, result: SyncResult) {
  if (result.error) sourceStatusStore.setError(sourceId, result.error)
  else sourceStatusStore.setSynced(sourceId)
}

export const storageRegistry = {
  resolve(sourceId: string): StorageAdapter {
    const adapter = adapters.find((candidate) => candidate.matches(sourceId))
    if (!adapter) throw new Error(`未知存储源：${sourceId}`)
    return adapter
  },

  listManagedSources(): StorageSource[] {
    return s3StorageAdapter.listSources()
  },

  async loadRemotePages(localPages: Page[] = []): Promise<{ pages: Page[]; syncResults: SyncResult[]; errors: Map<string, string> }> {
    const errors = new Map<string, string>()
    const pages: Page[] = []
    const syncResults: SyncResult[] = []

    if (await isTauri()) {
      const s3Results = await loadAllS3Pages(localPages)
      for (const syncResult of s3Results) {
        const reconciled = await this.reconcileLocalWins(syncResult, localPages)
        syncResults.push(reconciled)
        if (reconciled.error) {
          errors.set(reconciled.sourceId, reconciled.error)
          sourceStatusStore.setError(reconciled.sourceId, reconciled.error)
        } else {
          sourceStatusStore.setSynced(reconciled.sourceId)
        }
        pages.push(...reconciled.pages)
      }
    }

    const backendResults = await loadAllBackendPages(localPages)
    for (const syncResult of backendResults) {
      const reconciled = await this.reconcileLocalWins(syncResult, localPages)
      syncResults.push(reconciled)
      if (reconciled.error) {
        errors.set(reconciled.sourceId, reconciled.error)
        sourceStatusStore.setError(reconciled.sourceId, reconciled.error)
      } else {
        sourceStatusStore.setSynced(reconciled.sourceId)
      }
      pages.push(...reconciled.pages)
    }

    const backendS3Results = await loadAllBackendS3Pages(localPages)
    for (const syncResult of backendS3Results) {
      const reconciled = await this.reconcileLocalWins(syncResult, localPages)
      syncResults.push(reconciled)
      if (reconciled.error) {
        errors.set(reconciled.sourceId, reconciled.error)
        sourceStatusStore.setError(reconciled.sourceId, reconciled.error)
      } else {
        sourceStatusStore.setSynced(reconciled.sourceId)
      }
      pages.push(...reconciled.pages)
    }

    sourceStatusStore.refreshPendingCounts(syncQueue.pendingCountsBySource())
    return { pages, syncResults, errors }
  },

  async loadFileSnapshot(): Promise<WorkspaceSnapshot> {
    if (await isTauri()) return invoke<WorkspaceSnapshot>('load_workspace')
    const browser = loadBrowserSnapshot()
    const snapshot = localStorage.getItem('tie-demo-workspace-v1')
    const parsed = snapshot ? JSON.parse(snapshot) as WorkspaceSnapshot : {
      workspace: { id: 'local-demo', name: '我的知识库', sources: browserStorageAdapter.listSources() },
      pages: browser.pages,
    }
    return parsed
  },

  async mergeSnapshot(
    fileSnapshot: WorkspaceSnapshot,
    contextPages: Page[] = [],
    options: { remote?: boolean } = {},
  ): Promise<WorkspaceSnapshot> {
    const filePages = fileSnapshot.pages.filter((page) => !isBackendRemoteSourceId(page.storageSourceId) && !isS3SourceId(page.storageSourceId))
    if (options.remote === false) {
      return { workspace: fileSnapshot.workspace, pages: filePages }
    }
    const remote = await this.loadRemotePages(contextPages.length ? contextPages : filePages)
    return { workspace: fileSnapshot.workspace, pages: [...filePages, ...remote.pages] }
  },

  async savePage(page: Page, options?: SavePageOptions): Promise<Page> {
    return this.resolve(page.storageSourceId).savePage(page, options)
  },

  async permanentlyDeletePages(pages: Page[]) {
    const groups = new Map<string, Page[]>()
    pages.forEach((page) => {
      const list = groups.get(page.storageSourceId) ?? []
      list.push(page)
      groups.set(page.storageSourceId, list)
    })
    for (const [sourceId, group] of groups) {
      await this.resolve(sourceId).permanentlyDeletePages(sourceId, group)
    }
  },

  async transferPage(page: Page, targetSourceId: string): Promise<Page> {
    if (page.storageSourceId === targetSourceId) return page
    if (!canTransferBetweenSources(page.storageSourceId, targetSourceId)) {
      throw new Error(transferBlockedMessage(page.storageSourceId, targetSourceId))
    }

    if (isFileSourceId(page.storageSourceId) && isFileSourceId(targetSourceId) && await isTauri()) {
      return invoke<Page>('transfer_page_storage', { page, targetSourceId })
    }

    return this.transferPageCrossAdapter(page, targetSourceId)
  },

  async copyPageHistory(page: Page, fromSourceId: string, toSourceId: string) {
    if (!(await isTauri())) return
    if (isFileSourceId(fromSourceId) && isFileSourceId(toSourceId)) return

    if (isFileSourceId(fromSourceId) && isS3SourceId(toSourceId)) {
      await invoke('copy_file_history_to_s3', {
        pageId: page.id,
        fileSourceId: fromSourceId,
        connection: s3ConnectionForSource(toSourceId),
      })
      return
    }
    if (isS3SourceId(fromSourceId) && isFileSourceId(toSourceId)) {
      await invoke('copy_s3_history_to_file', {
        connection: s3ConnectionForSource(fromSourceId),
        pageId: page.id,
        fileSourceId: toSourceId,
      })
      return
    }
    if (isS3SourceId(fromSourceId) && isS3SourceId(toSourceId)) {
      await invoke('copy_s3_history_to_s3', {
        source: s3ConnectionForSource(fromSourceId),
        target: s3ConnectionForSource(toSourceId),
        pageId: page.id,
      })
    }
  },

  async copyPageAssets(page: Page, fromSourceId: string, toSourceId: string) {
    if (fromSourceId === toSourceId) return
    if (isFileSourceId(fromSourceId) && isFileSourceId(toSourceId)) return

    if (isBackendRemoteSourceId(fromSourceId) || isBackendRemoteSourceId(toSourceId)) {
      await copyPageAssetsBetweenSources(page, fromSourceId, toSourceId)
      return
    }

    if (!(await isTauri())) return

    if (isFileSourceId(fromSourceId) && isS3SourceId(toSourceId)) {
      await invoke('copy_file_assets_to_s3', {
        pageId: page.id,
        fileSourceId: fromSourceId,
        connection: s3ConnectionForSource(toSourceId),
      })
      return
    }
    if (isS3SourceId(fromSourceId) && isFileSourceId(toSourceId)) {
      await invoke('copy_s3_assets_to_file', {
        connection: s3ConnectionForSource(fromSourceId),
        pageId: page.id,
        fileSourceId: toSourceId,
      })
      return
    }
    if (isS3SourceId(fromSourceId) && isS3SourceId(toSourceId)) {
      await invoke('copy_s3_assets_to_s3', {
        source: s3ConnectionForSource(fromSourceId),
        target: s3ConnectionForSource(toSourceId),
        pageId: page.id,
      })
    }
  },

  async transferPageCrossAdapter(page: Page, targetSourceId: string): Promise<Page> {
    const sourceAdapter = this.resolve(page.storageSourceId)
    const targetAdapter = this.resolve(targetSourceId)
    const transferred = { ...page, storageSourceId: targetSourceId }
    await targetAdapter.savePage(transferred)
    try {
      await this.copyPageHistory(page, page.storageSourceId, targetSourceId)
    } catch (error) {
      console.warn('历史版本迁移失败', error)
    }
    try {
      await this.copyPageAssets(page, page.storageSourceId, targetSourceId)
    } catch (error) {
      console.warn('页面附件迁移失败', error)
    }
    await sourceAdapter.permanentlyDeletePages(page.storageSourceId, [page])
    return transferred
  },

  async listPageRevisions(page: Page): Promise<PageRevision[]> {
    const adapter = this.resolve(page.storageSourceId)
    return adapter.listPageRevisions?.(page) ?? []
  },

  async readPageRevision(page: Page, revisionId: string): Promise<Page> {
    const adapter = this.resolve(page.storageSourceId)
    if (!adapter.readPageRevision) throw new Error('该存储源不支持历史版本')
    return adapter.readPageRevision(page, revisionId)
  },

  async readLatestPage(page: Page): Promise<Page | null> {
    const adapter = this.resolve(page.storageSourceId)
    return adapter.readLatestPage?.(page) ?? null
  },

  async reconcileLocalWins(result: SyncResult, localPages: Page[] = []): Promise<SyncResult> {
    if (result.error || !result.conflicts.length) return result
    const remainingConflicts = []
    for (const conflict of result.conflicts) {
      if (!isLocalWinningConflict(conflict)) {
        remainingConflicts.push(conflict)
        continue
      }
      const page = result.pages.find((item) => item.id === conflict.pageId)
        ?? localPages.find((item) => item.id === conflict.pageId && item.storageSourceId === result.sourceId)
      if (!page) {
        remainingConflicts.push(conflict)
        continue
      }
      try {
        await this.savePage(page, { force: true, queueOnFailure: true })
      } catch {
        remainingConflicts.push(conflict)
      }
    }
    return { ...result, conflicts: remainingConflicts }
  },

  async syncSource(sourceId: string, localPages: Page[] = []): Promise<SyncResult> {
    const adapter = this.resolve(sourceId)
    if (!adapter.syncSource) return emptySyncResult(sourceId)
    sourceStatusStore.setSyncing(sourceId)
    try {
      const result = await adapter.syncSource(sourceId, { localPages })
      const reconciled = await this.reconcileLocalWins(result, localPages)
      applySyncStatus(sourceId, reconciled)
      return reconciled
    } catch (error) {
      const message = error instanceof Error ? error.message : '同步失败'
      sourceStatusStore.setError(sourceId, message)
      return emptySyncResult(sourceId, message)
    } finally {
      sourceStatusStore.refreshPendingCounts(syncQueue.pendingCountsBySource())
    }
  },

  async flushSyncQueue() {
    const items = syncQueue.list()
    const savedPages: Page[] = []
    for (const item of items) {
      try {
        if (item.operation === 'save') {
          const saved = await this.savePage(item.page, { expectedUpdatedAt: item.expectedUpdatedAt, queueOnFailure: false })
          savedPages.push(saved)
        } else if (item.operation === 'delete' && item.pageIds?.length) {
          await this.resolve(item.sourceId).permanentlyDeletePages(
            item.sourceId,
            item.pageIds.map((pageId) => ({ ...item.page, id: pageId })),
          )
        }
        syncQueue.remove(item.id)
      } catch (error) {
        syncQueue.markFailed(item.id, error instanceof Error ? error.message : '同步失败')
      }
    }
    sourceStatusStore.refreshPendingCounts(syncQueue.pendingCountsBySource())
    return savedPages
  },

  async renameSource(sourceId: string, name: string) {
    const adapter = this.resolve(sourceId)
    if (!adapter.renameSource) throw new Error('该存储源不支持重命名')
    await adapter.renameSource(sourceId, name)
  },

  async removeSource(sourceId: string) {
    const adapter = this.resolve(sourceId)
    if (!adapter.removeSource) throw new Error('该存储源不支持断开连接')
    await adapter.removeSource(sourceId)
    sourceStatusStore.remove(sourceId)
  },

  async saveS3Connection(input: S3ConnectionInput) {
    if (!s3StorageAdapter.saveConnection) throw new Error('S3 连接不可用')
    return s3StorageAdapter.saveConnection(input)
  },

  async updateS3Connection(sourceId: string, input: Partial<S3ConnectionInput>) {
    if (!s3StorageAdapter.updateConnection) throw new Error('S3 连接不可用')
    return s3StorageAdapter.updateConnection(sourceId, input)
  },

  getSourceStatus(sourceId: string) {
    return sourceStatusStore.get(sourceId)
  },

  canManage(sourceId: string) {
    return this.resolve(sourceId).capabilities.manageConnection
  },

  canTransfer(fromSourceId: string, toSourceId: string) {
    return canTransferBetweenSources(fromSourceId, toSourceId)
  },
}
