import { invoke } from '@tauri-apps/api/core'
import type { Page, PageRevision, StorageSource } from '@/types'
import { isRetryableStorageError, queueFailureMessage } from '@/services/storage/retry'
import { emptySyncResult, mergeSyncPages } from '@/services/storage/sync-merge'
import { syncQueue } from '@/services/storage/sync-queue'
import type { SavePageOptions, StorageAdapter, StorageCapabilities, SyncSourceContext } from '@/services/storage/types'
import { isFileSourceId } from '@/services/storage/types'

const capabilities: StorageCapabilities = {
  load: true,
  save: true,
  delete: true,
  transfer: true,
  revisions: true,
  import: true,
  remote: false,
  manageConnection: true,
}

async function isTauri() {
  return '__TAURI_INTERNALS__' in window
}

export const fileStorageAdapter: StorageAdapter = {
  kind: 'local',
  capabilities,
  matches(sourceId) {
    return isFileSourceId(sourceId)
  },
  listSources() {
    return []
  },
  async loadPages(sourceId) {
    if (!(await isTauri())) return { pages: [] }
    const snapshot = await invoke<{ pages: Page[] }>('load_workspace')
    return { pages: snapshot.pages.filter((page) => page.storageSourceId === sourceId) }
  },
  async savePage(page, options?: SavePageOptions) {
    if (!(await isTauri())) throw new Error('文件存储仅支持桌面端')
    try {
      const saved = await invoke<Page>('save_page', {
        page,
        expectedUpdatedAt: options?.force ? null : (options?.expectedUpdatedAt ?? null),
      })
      syncQueue.removeForPage(page.id)
      return saved
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('其他设备更新')) throw new Error('页面已在其他设备更新，请重新载入后再保存')
      if (options?.queueOnFailure !== false && isRetryableStorageError(error, 'file')) {
        syncQueue.enqueueSave(page, options?.expectedUpdatedAt)
        throw new Error(queueFailureMessage(error, '保存'))
      }
      throw error
    }
  },
  async permanentlyDeletePages(_sourceId, pages) {
    if (!(await isTauri())) throw new Error('文件存储仅支持桌面端')
    try {
      await invoke('permanently_delete_pages', { pages })
      pages.forEach((page) => syncQueue.removeForPage(page.id))
    } catch (error) {
      if (isRetryableStorageError(error, 'file')) {
        syncQueue.enqueueDelete(_sourceId, pages)
        throw new Error(queueFailureMessage(error, '删除'))
      }
      throw error
    }
  },
  async transferPage(page, targetSourceId) {
    if (!(await isTauri())) throw new Error('文件存储仅支持桌面端')
    return invoke<Page>('transfer_page_storage', { page, targetSourceId })
  },
  async listPageRevisions(page) {
    if (!(await isTauri())) return []
    return invoke<PageRevision[]>('list_page_revisions', { pageId: page.id, storageSourceId: page.storageSourceId })
  },
  async readPageRevision(page, revisionId) {
    if (!(await isTauri())) throw new Error('文件存储仅支持桌面端')
    return invoke<Page>('read_page_revision', { page, revisionId })
  },
  async syncSource(sourceId, context?: SyncSourceContext) {
    try {
      const loaded = await this.loadPages(sourceId)
      if (loaded.error) return emptySyncResult(sourceId, loaded.error)
      const remoteIds = new Set(loaded.pages.map((page) => page.id))
      return mergeSyncPages(sourceId, context?.localPages ?? [], loaded.pages, remoteIds)
    } catch (error) {
      return emptySyncResult(sourceId, error instanceof Error ? error.message : '同步失败')
    }
  },
  async renameSource(sourceId, name) {
    if (!(await isTauri())) throw new Error('文件存储仅支持桌面端')
    await invoke<StorageSource>('rename_storage_source', { sourceId, name })
  },
  async removeSource(sourceId) {
    if (!(await isTauri())) throw new Error('文件存储仅支持桌面端')
    await invoke('remove_storage_source', { sourceId })
  },
}
