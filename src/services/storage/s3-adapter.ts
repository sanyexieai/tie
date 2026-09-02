import { invoke } from '@tauri-apps/api/core'
import type { Page } from '@/types'
import {
  loadS3SyncState,
  nextS3SyncState,
  pageIdsMissingFromResult,
  pageIdsNeedingDownload,
  saveS3SyncState,
  type S3PageIndexEntry,
} from '@/services/s3-sync-state'
import {
  createStableS3ProviderId,
  isS3SourceId,
  loadLocalS3Providers,
  providerForS3Source,
  removeS3ProviderAsync,
  s3ConnectionForSource,
  s3SourceId,
  s3StorageSource,
  upsertS3ProviderAsync,
  type LocalS3Provider,
} from '@/services/s3'
import { isRetryableStorageError, queueFailureMessage } from '@/services/storage/retry'
import { pageBoundToSource } from '@/services/page-sources'
import { emptySyncResult, mergeSyncPages } from '@/services/storage/sync-merge'
import { syncQueue } from '@/services/storage/sync-queue'
import type { S3ConnectionInput, SavePageOptions, StorageAdapter, StorageCapabilities, SyncResult, SyncSourceContext } from '@/services/storage/types'

const capabilities: StorageCapabilities = {
  load: true,
  save: true,
  delete: true,
  transfer: true,
  revisions: true,
  import: false,
  remote: true,
  manageConnection: true,
}

async function isTauri() {
  return '__TAURI_INTERNALS__' in window
}

function connectionFor(sourceId: string) {
  return s3ConnectionForSource(sourceId)
}

async function testAndSaveCredentials(input: S3ConnectionInput, providerId: string) {
  if (!(await isTauri())) throw new Error('Web 预览无法访问系统凭据库，请使用桌面端保存 S3 凭据。')
  await invoke('save_s3_credentials', {
    providerId,
    accessKey: input.accessKey.trim(),
    secretKey: input.secretKey,
  })
  try {
    await invoke('test_s3_connection', {
      providerId,
      endpoint: input.endpoint.trim(),
      bucket: input.bucket.trim(),
      region: input.region?.trim() || null,
    })
  } catch (error) {
    await invoke('remove_s3_credentials', { providerId }).catch(() => undefined)
    throw error
  }
}

async function loadIndexedPages(sourceId: string, context?: SyncSourceContext) {
  const provider = providerForS3Source(sourceId)
  if (!provider) throw new Error('S3 连接不存在')
  const connection = connectionFor(sourceId)
  const index = await invoke<S3PageIndexEntry[]>('list_s3_page_index', { connection })
  const cached = loadS3SyncState(provider.id)
  const downloadIds = pageIdsNeedingDownload(index, cached)
  const remoteIds = new Set(index.map((entry) => entry.pageId))

  let downloaded: Page[] = []
  if (!cached.lastSyncAt || downloadIds.length === index.length) {
    downloaded = await invoke<Page[]>('load_s3_pages', { connection })
  } else if (downloadIds.length) {
    downloaded = await invoke<Page[]>('load_s3_pages_by_ids', { connection, pageIds: downloadIds })
  }

  const unchangedPages = (context?.localPages ?? [])
    .filter((page) => pageBoundToSource(page, sourceId) && remoteIds.has(page.id) && !downloadIds.includes(page.id))

  // 增量缓存认为「未变」时不会进 downloadIds；若本机上下文也没有该页（冷启动、仅云端），必须补拉。
  const presentIds = new Set([...unchangedPages, ...downloaded].map((page) => page.id))
  const missingIds = pageIdsMissingFromResult(index, presentIds)
  if (missingIds.length) {
    const extras = await invoke<Page[]>('load_s3_pages_by_ids', { connection, pageIds: missingIds })
    downloaded = [...downloaded, ...extras]
  }

  saveS3SyncState(provider.id, nextS3SyncState(index))

  const mergedRemote = [...unchangedPages, ...downloaded]
  return mergeSyncPages(sourceId, context?.localPages ?? [], mergedRemote, remoteIds)
}

export const s3StorageAdapter: StorageAdapter = {
  kind: 's3',
  capabilities,
  matches(sourceId) {
    return isS3SourceId(sourceId)
  },
  listSources() {
    return loadLocalS3Providers().map(s3StorageSource)
  },
  async loadPages(sourceId) {
    if (!(await isTauri())) return { pages: [], error: 'S3 页面仅支持桌面端' }
    const provider = providerForS3Source(sourceId)
    if (!provider) return { pages: [], error: 'S3 连接不存在' }
    if (!provider.credentialStored) return { pages: [], error: '缺少本机密钥，请重新保存该连接' }
    try {
      const result = await this.syncSource!(sourceId)
      if (result.error) return { pages: [], error: result.error }
      return { pages: result.pages }
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法加载 S3 页面'
      return { pages: [], error: message }
    }
  },
  async savePage(page, options?: SavePageOptions) {
    if (!(await isTauri())) throw new Error('S3 页面仅支持桌面端')
    const writeId = options?.writeSourceId ?? page.storageSourceId
    const provider = providerForS3Source(writeId)
    if (!provider?.credentialStored) throw new Error('未找到 S3 本机密钥，请重新保存该连接')
    try {
      const saved = await invoke<Page>('save_s3_page', {
        connection: connectionFor(writeId),
        page: { ...page, storageSourceId: page.storageSourceId },
        expectedUpdatedAt: options?.force ? null : (options?.expectedUpdatedAt ?? null),
      })
      syncQueue.removeForPage(page.id)
      return { ...saved, storageSourceId: page.storageSourceId, storageSourceIds: page.storageSourceIds }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('其他设备更新')) throw new Error('页面已在其他设备更新，请重新载入后再保存')
      if (options?.queueOnFailure !== false && isRetryableStorageError(error, 's3')) {
        syncQueue.enqueueSave(page, options?.expectedUpdatedAt)
        throw new Error(queueFailureMessage(error, '保存'))
      }
      throw error
    }
  },
  async permanentlyDeletePages(sourceId, pages) {
    if (!(await isTauri())) throw new Error('S3 页面仅支持桌面端')
    const pageIds = pages.map((page) => page.id)
    try {
      await invoke('permanently_delete_s3_pages', {
        connection: connectionFor(sourceId),
        pageIds,
      })
      pageIds.forEach((pageId) => syncQueue.removeForPage(pageId))
    } catch (error) {
      if (isRetryableStorageError(error, 's3')) {
        syncQueue.enqueueDelete(sourceId, pages)
        throw new Error(queueFailureMessage(error, '删除'))
      }
      throw error
    }
  },
  async listPageRevisions(page) {
    if (!(await isTauri())) return []
    return invoke<Array<{ id: string; savedAt: string; title: string }>>('list_s3_page_revisions', {
      connection: connectionFor(page.storageSourceId),
      pageId: page.id,
    })
  },
  async readPageRevision(page, revisionId) {
    if (!(await isTauri())) throw new Error('S3 历史版本仅支持桌面端')
    return invoke<Page>('read_s3_page_revision', {
      connection: connectionFor(page.storageSourceId),
      page,
      revisionId,
    })
  },
  async readLatestPage(page) {
    if (!(await isTauri())) throw new Error('S3 页面仅支持桌面端')
    const pages = await invoke<Page[]>('load_s3_pages_by_ids', {
      connection: connectionFor(page.storageSourceId),
      pageIds: [page.id],
    })
    return pages[0] ?? null
  },
  async syncSource(sourceId, context?: SyncSourceContext) {
    if (!(await isTauri())) return emptySyncResult(sourceId, 'S3 页面仅支持桌面端')
    const provider = providerForS3Source(sourceId)
    if (!provider) return emptySyncResult(sourceId, 'S3 连接不存在')
    if (!provider.credentialStored) return emptySyncResult(sourceId, '缺少本机密钥，请重新保存该连接')
    try {
      return await loadIndexedPages(sourceId, context)
    } catch (error) {
      return emptySyncResult(sourceId, error instanceof Error ? error.message : 'S3 同步失败')
    }
  },
  async renameSource(sourceId, name) {
    const provider = providerForS3Source(sourceId)
    if (!provider) throw new Error('S3 连接不存在')
    await upsertS3ProviderAsync({ ...provider, name: name.trim() })
  },
  async removeSource(sourceId) {
    const provider = providerForS3Source(sourceId)
    if (!provider) return
    if (await isTauri()) {
      await invoke('remove_s3_credentials', { providerId: provider.id }).catch(() => undefined)
    }
    await removeS3ProviderAsync(provider.id)
    localStorage.removeItem(`tie-s3-sync-state-v1:${provider.id}`)
  },
  async saveConnection(input) {
    const providerId = input.id?.trim() || createStableS3ProviderId(input.endpoint, input.bucket)
    const stableId = createStableS3ProviderId(input.endpoint, input.bucket)
    // 新建用指纹；更新若仍是旧 UUID，迁到指纹并写一份新凭据。
    const writeId = providerId === stableId ? providerId : stableId
    if (providerId !== writeId) {
      await testAndSaveCredentials(input, writeId)
      await invoke('remove_s3_credentials', { providerId }).catch(() => undefined)
    } else {
      await testAndSaveCredentials(input, writeId)
    }
    const provider: LocalS3Provider = {
      id: writeId,
      name: input.name.trim() || input.bucket.trim(),
      endpoint: input.endpoint.trim(),
      bucket: input.bucket.trim(),
      region: input.region?.trim() || undefined,
      credentialStored: true,
      createdAt: new Date().toISOString(),
    }
    await upsertS3ProviderAsync(provider)
    return s3StorageSource(provider)
  },
  async updateConnection(sourceId, input) {
    const provider = providerForS3Source(sourceId)
    if (!provider) throw new Error('S3 连接不存在')
    const next: LocalS3Provider = {
      ...provider,
      name: input.name?.trim() || provider.name,
      endpoint: input.endpoint?.trim() || provider.endpoint,
      bucket: input.bucket?.trim() || provider.bucket,
      region: input.region !== undefined ? (input.region.trim() || undefined) : provider.region,
    }
    const stableId = createStableS3ProviderId(next.endpoint, next.bucket)
    next.id = stableId
    if (input.accessKey && input.secretKey) {
      await testAndSaveCredentials({ ...next, ...input, accessKey: input.accessKey, secretKey: input.secretKey }, stableId)
      if (provider.id !== stableId) {
        await invoke('remove_s3_credentials', { providerId: provider.id }).catch(() => undefined)
      }
      next.credentialStored = true
    } else if (await isTauri()) {
      if (provider.id !== stableId) {
        // 无新密钥时依赖 Rust load/upsert 侧迁移凭据；先用旧 id 测连通。
        await invoke('test_s3_connection', {
          providerId: provider.id,
          endpoint: next.endpoint,
          bucket: next.bucket,
          region: next.region ?? null,
        })
      } else {
        await invoke('test_s3_connection', {
          providerId: stableId,
          endpoint: next.endpoint,
          bucket: next.bucket,
          region: next.region ?? null,
        })
      }
    }
    await upsertS3ProviderAsync(next)
    return s3StorageSource(next)
  },
}

export async function loadAllS3Pages(localPages: Page[] = []): Promise<SyncResult[]> {
  const providers = loadLocalS3Providers().filter((provider) => provider.credentialStored)
  return Promise.all(providers.map((provider) => s3StorageAdapter.syncSource!(s3SourceId(provider.id), { localPages })))
}
