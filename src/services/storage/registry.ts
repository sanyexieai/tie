import { invoke } from '@tauri-apps/api/core'
import type { Page, PageRevision, StorageSource, WorkspaceSnapshot } from '@/types'
import { isBackendRemoteSourceId } from '@/services/backend'
import { copyPageAssets as copyPageAssetsBetweenSources, ensurePageAssetsOnSource } from '@/services/attachments'
import { mergePagesById, normalizePageSources, pageBoundToSource, pageContentEqual, pageForStorageWrite, pageMirrorSourceIds, pageSourceIds, remapPageSourceIds, withPageSources } from '@/services/page-sources'
import { canTransferBetweenSources, transferBlockedMessage } from '@/services/transfer-policy'
import { isS3SourceId, s3ConnectionForSource, buildS3SourceIdHealingRemap } from '@/services/s3'
import { isCloudStorageSourceId } from '@/services/storage-identity'
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
    // 磁盘上读到的页面都要保留。协作主源改成云端后，frontmatter 里可能是 s3:/backend:，
    // 不能再按 primary 类型过滤，否则本机副本会在启动时被丢掉。
    const healing = buildS3SourceIdHealingRemap(fileSnapshot.pages)
    const filePages = fileSnapshot.pages.map((page) => {
      const normalized = normalizePageSources(page)
      return healing.size ? remapPageSourceIds(normalized, healing) : normalized
    })
    if (options.remote === false) {
      return { workspace: fileSnapshot.workspace, pages: mergePagesById(filePages) }
    }
    const remote = await this.loadRemotePages(contextPages.length ? contextPages : filePages)
    return {
      workspace: fileSnapshot.workspace,
      pages: mergePagesById([...filePages, ...remote.pages.map((page) => normalizePageSources(page))]),
    }
  },

  async savePage(page: Page, options?: SavePageOptions): Promise<Page> {
    const normalized = normalizePageSources(page)
    const primaryWrite = options?.writeSourceId ?? normalized.storageSourceId
    if (!options?.force) {
      const latest = await this.readLatestPage({
        ...normalized,
        storageSourceId: primaryWrite,
      }).catch(() => null)
      if (latest && pageContentEqual(latest, normalized)) {
        return normalizePageSources({
          ...latest,
          storageSourceId: normalized.storageSourceId,
          storageSourceIds: pageSourceIds(normalized),
        })
      }
    }
    // 方案 A：日常保存只写协作主源；写云端时剥离本机 sourceId。
    const forWrite = pageForStorageWrite(normalized, primaryWrite)
    // 正文上云前先把引用到的附件补到目标源，避免另一端只有 markdown、没有图。
    if (isCloudStorageSourceId(primaryWrite)) {
      try {
        await ensurePageAssetsOnSource(normalized, primaryWrite)
      } catch (error) {
        console.warn('保存前同步页面附件失败', error)
      }
    }
    const saved = await this.resolve(primaryWrite).savePage(forWrite, {
      ...options,
      writeSourceId: primaryWrite,
    })
    return normalizePageSources({
      ...saved,
      storageSourceId: normalized.storageSourceId,
      storageSourceIds: pageSourceIds(normalized),
    })
  },

  /** 把当前主源内容强制推到所有备份镜像（正文 + 附件）。 */
  async pushPageToMirrors(page: Page): Promise<Page> {
    const normalized = normalizePageSources(page)
    const mirrors = pageMirrorSourceIds(normalized)
    if (!mirrors.length) return normalized
    for (const sourceId of mirrors) {
      const forWrite = pageForStorageWrite(normalized, sourceId)
      await this.resolve(sourceId).savePage(forWrite, {
        force: true,
        queueOnFailure: true,
        writeSourceId: sourceId,
      })
      try {
        await this.copyPageAssets(normalized, normalized.storageSourceId, sourceId)
      } catch (error) {
        console.warn(`备份源 ${sourceId} 附件同步失败`, error)
      }
    }
    return normalized
  },

  async permanentlyDeletePages(pages: Page[]) {
    for (const page of pages) {
      for (const sourceId of pageSourceIds(page)) {
        await this.resolve(sourceId).permanentlyDeletePages(sourceId, [{ ...page, storageSourceId: sourceId }])
      }
    }
  },

  async bindPageToSource(page: Page, targetSourceId: string): Promise<Page> {
    const normalized = normalizePageSources(page)
    if (pageBoundToSource(normalized, targetSourceId)) return normalized
    if (!canTransferBetweenSources(normalized.storageSourceId, targetSourceId)) {
      throw new Error(transferBlockedMessage(normalized.storageSourceId, targetSourceId))
    }
    const next = withPageSources(normalized, normalized.storageSourceId, [...pageSourceIds(normalized), targetSourceId])
    // withPageSources 在存在云端绑定时会自动把主源收束到云端。
    if (isFileSourceId(normalized.storageSourceId) && isFileSourceId(targetSourceId) && await isTauri()) {
      await invoke('copy_page_sidecars', {
        pageId: next.id,
        fromSourceId: normalized.storageSourceId,
        toSourceId: targetSourceId,
      })
    } else {
      await this.copyPageHistory(next, normalized.storageSourceId, targetSourceId)
      await this.copyPageAssets(next, normalized.storageSourceId, targetSourceId)
    }
    // 初次绑定：把当前正文种子写入备份镜像，之后日常保存不再自动双写。
    await this.resolve(targetSourceId).savePage(pageForStorageWrite(next, targetSourceId), {
      force: true,
      writeSourceId: targetSourceId,
    })
    return this.savePage(next, { force: true })
  },

  async unbindPageFromSource(page: Page, sourceId: string): Promise<Page> {
    const normalized = normalizePageSources(page)
    const ids = pageSourceIds(normalized)
    if (!ids.includes(sourceId)) return normalized
    if (ids.length <= 1) throw new Error('至少需要保留一个存储源')
    const nextIds = ids.filter((id) => id !== sourceId)
    const primary = normalized.storageSourceId === sourceId ? nextIds[0]! : normalized.storageSourceId
    const next = withPageSources(normalized, primary, nextIds)
    await this.resolve(sourceId).permanentlyDeletePages(sourceId, [{ ...normalized, storageSourceId: sourceId }])
    return this.savePage(next, { force: true })
  },

  async setPagePrimarySource(page: Page, sourceId: string): Promise<Page> {
    const normalized = normalizePageSources(page)
    if (!pageBoundToSource(normalized, sourceId)) throw new Error('尚未绑定该存储源')
    if (!isCloudStorageSourceId(sourceId)) {
      throw new Error('协作主源只能是云端存储（S3 / 后台）')
    }
    return this.savePage(withPageSources(normalized, sourceId, pageSourceIds(normalized)), { force: true })
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
    const targetAdapter = this.resolve(targetSourceId)
    const transferred = withPageSources(page, targetSourceId, [targetSourceId])
    await targetAdapter.savePage(transferred, { writeSourceId: targetSourceId, force: true })
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
    for (const sourceId of pageSourceIds(page)) {
      try {
        await this.resolve(sourceId).permanentlyDeletePages(sourceId, [{ ...page, storageSourceId: sourceId }])
      } catch (error) {
        if (sourceId === page.storageSourceId) throw error
        console.warn('清理旧绑定源失败', error)
      }
    }
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
          const latest = await this.readLatestPage(item.page).catch(() => null)
          if (latest && pageContentEqual(latest, item.page)) {
            savedPages.push(normalizePageSources({
              ...latest,
              storageSourceId: item.page.storageSourceId,
              storageSourceIds: pageSourceIds(item.page),
            }))
            syncQueue.remove(item.id)
            continue
          }
          let expectedUpdatedAt = item.expectedUpdatedAt
          if (latest && expectedUpdatedAt && latest.updatedAt !== expectedUpdatedAt && pageContentEqual(latest, item.page)) {
            expectedUpdatedAt = latest.updatedAt
          }
          const saved = await this.savePage(item.page, { expectedUpdatedAt, queueOnFailure: false })
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
