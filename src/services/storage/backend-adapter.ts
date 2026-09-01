import type { Page, StorageSource } from '@/types'
import { backendService, backendWorkspaceSource, isBackendSourceId, parseBackendWorkspaceId } from '@/services/backend'
import { isRetryableStorageError, queueFailureMessage } from '@/services/storage/retry'
import { emptySyncResult, mergeSyncPages } from '@/services/storage/sync-merge'
import { syncQueue } from '@/services/storage/sync-queue'
import type { SavePageOptions, StorageAdapter, StorageCapabilities, SyncResult, SyncSourceContext } from '@/services/storage/types'

const capabilities: StorageCapabilities = {
  load: true,
  save: true,
  delete: true,
  transfer: false,
  revisions: true,
  import: false,
  remote: true,
  manageConnection: false,
}

export const backendStorageAdapter: StorageAdapter = {
  kind: 'backend',
  capabilities,
  matches(sourceId) {
    return isBackendSourceId(sourceId)
  },
  listSources() {
    return []
  },
  async loadPages(sourceId) {
    const profile = backendService.loadProfile()
    if (!profile.accessToken) return { pages: [], error: '请先连接自定义后台' }
    try {
      const workspaceId = parseBackendWorkspaceId(sourceId)
      const pages = await backendService.listPages(profile, workspaceId)
      return { pages: pages.map((page) => ({ ...page, storageSourceId: sourceId })) }
    } catch (error) {
      return { pages: [], error: error instanceof Error ? error.message : '后台页面加载失败' }
    }
  },
  async savePage(page, options?: SavePageOptions) {
    const profile = backendService.loadProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    const writeId = options?.writeSourceId ?? page.storageSourceId
    try {
      const saved = await backendService.savePage(
        profile,
        parseBackendWorkspaceId(writeId),
        page,
        options?.force ? undefined : options?.expectedUpdatedAt,
      )
      syncQueue.removeForPage(page.id)
      return { ...saved, storageSourceId: page.storageSourceId, storageSourceIds: page.storageSourceIds }
    } catch (error) {
      if (options?.queueOnFailure !== false && isRetryableStorageError(error, 'backend')) {
        syncQueue.enqueueSave(page, options?.expectedUpdatedAt)
        throw new Error(queueFailureMessage(error, '保存'))
      }
      throw error
    }
  },
  async permanentlyDeletePages(sourceId, pages) {
    const profile = backendService.loadProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    const pageIds = pages.map((page) => page.id)
    try {
      await backendService.deletePages(profile, parseBackendWorkspaceId(sourceId), pageIds)
      pageIds.forEach((pageId) => syncQueue.removeForPage(pageId))
    } catch (error) {
      if (isRetryableStorageError(error, 'backend')) {
        syncQueue.enqueueDelete(sourceId, pages)
        throw new Error(queueFailureMessage(error, '删除'))
      }
      throw error
    }
  },
  async listPageRevisions(page) {
    const profile = backendService.loadProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    return backendService.listPageRevisions(profile, parseBackendWorkspaceId(page.storageSourceId), page.id)
  },
  async readPageRevision(page, revisionId) {
    const profile = backendService.loadProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    const revision = await backendService.readPageRevision(profile, parseBackendWorkspaceId(page.storageSourceId), page.id, revisionId)
    return { ...revision, storageSourceId: page.storageSourceId }
  },
  async readLatestPage(page) {
    const profile = backendService.loadProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    const remote = await backendService.getPage(profile, parseBackendWorkspaceId(page.storageSourceId), page.id)
    return { ...remote, storageSourceId: page.storageSourceId }
  },
  async syncSource(sourceId, context?: SyncSourceContext) {
    try {
      const loaded = await this.loadPages(sourceId)
      if (loaded.error) return emptySyncResult(sourceId, loaded.error)
      const remoteIds = new Set(loaded.pages.map((page) => page.id))
      return mergeSyncPages(sourceId, context?.localPages ?? [], loaded.pages, remoteIds)
    } catch (error) {
      return emptySyncResult(sourceId, error instanceof Error ? error.message : '后台同步失败')
    }
  },
}

export async function loadAllBackendPages(localPages: Page[] = []): Promise<SyncResult[]> {
  const profile = backendService.loadProfile()
  if (!profile.accessToken) return []
  try {
    const pages = await backendService.loadAllPages(profile, (workspaceId) => `backend:${workspaceId}`)
    const grouped = new Map<string, Page[]>()
    pages.forEach((page) => {
      const list = grouped.get(page.storageSourceId) ?? []
      list.push(page)
      grouped.set(page.storageSourceId, list)
    })
    return [...grouped.entries()].map(([sourceId, sourcePages]) => {
      const remoteIds = new Set(sourcePages.map((page) => page.id))
      return mergeSyncPages(sourceId, localPages, sourcePages, remoteIds)
    })
  } catch (error) {
    return [{ ...emptySyncResult('backend', error instanceof Error ? error.message : '后台页面加载失败') }]
  }
}

export async function listBackendSources(): Promise<StorageSource[]> {
  const profile = backendService.loadProfile()
  if (!profile.accessToken) return []
  const workspaces = await backendService.listWorkspaces(profile)
  return workspaces.map((workspace) => backendWorkspaceSource(workspace, profile.endpoint))
}
