import type { Page, StorageSource } from '@/types'
import {
  backendService,
  backendS3ProviderSource,
  isBackendManagedS3SourceId,
  parseBackendProviderId,
} from '@/services/backend'
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

export const backendS3StorageAdapter: StorageAdapter = {
  kind: 's3',
  capabilities,
  matches(sourceId) {
    return isBackendManagedS3SourceId(sourceId)
  },
  listSources() {
    return []
  },
  async loadPages(sourceId) {
    const profile = backendService.loadProfile()
    if (!profile.accessToken) return { pages: [], error: '请先连接自定义后台' }
    try {
      const providerId = parseBackendProviderId(sourceId)
      const pages = await backendService.listProviderPages(profile, providerId)
      return { pages: pages.map((page) => ({ ...page, storageSourceId: sourceId })) }
    } catch (error) {
      return { pages: [], error: error instanceof Error ? error.message : '后台 S3 页面加载失败' }
    }
  },
  async savePage(page, options?: SavePageOptions) {
    const profile = backendService.loadProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    const writeId = options?.writeSourceId ?? page.storageSourceId
    try {
      const saved = await backendService.saveProviderPage(
        profile,
        parseBackendProviderId(writeId),
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
      await backendService.deleteProviderPages(profile, parseBackendProviderId(sourceId), pageIds)
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
    return backendService.listProviderPageRevisions(profile, parseBackendProviderId(page.storageSourceId), page.id)
  },
  async readPageRevision(page, revisionId) {
    const profile = backendService.loadProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    const revision = await backendService.readProviderPageRevision(
      profile,
      parseBackendProviderId(page.storageSourceId),
      page.id,
      revisionId,
    )
    return { ...revision, storageSourceId: page.storageSourceId }
  },
  async readLatestPage(page) {
    const profile = backendService.loadProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    const remote = await backendService.getProviderPage(profile, parseBackendProviderId(page.storageSourceId), page.id)
    return { ...remote, storageSourceId: page.storageSourceId }
  },
  async syncSource(sourceId, context?: SyncSourceContext) {
    try {
      const loaded = await this.loadPages(sourceId)
      if (loaded.error) return emptySyncResult(sourceId, loaded.error)
      const remoteIds = new Set(loaded.pages.map((page) => page.id))
      return mergeSyncPages(sourceId, context?.localPages ?? [], loaded.pages, remoteIds)
    } catch (error) {
      return emptySyncResult(sourceId, error instanceof Error ? error.message : '后台 S3 同步失败')
    }
  },
}

export async function loadAllBackendS3Pages(localPages: Page[] = []): Promise<SyncResult[]> {
  const profile = backendService.loadProfile()
  if (!profile.accessToken) return []
  try {
    const pages = await backendService.loadAllProviderPages(profile, (providerId) => `backend-s3:${providerId}`)
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
    return [{ ...emptySyncResult('backend-s3', error instanceof Error ? error.message : '后台 S3 页面加载失败') }]
  }
}

export async function listBackendS3Sources(): Promise<StorageSource[]> {
  const profile = backendService.loadProfile()
  if (!profile.accessToken) return []
  const providers = await backendService.listProviders(profile)
  return providers.filter((provider) => provider.kind === 's3').map((provider) => backendS3ProviderSource(provider))
}
