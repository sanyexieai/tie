/**
 * 工作区存储后端：磁盘（默认）或绑定的 S3 Provider。
 * 对外统一为 backend:{workspaceId}，S3 只是服务端落盘方式。
 */
import { parsePage } from './page-format.js'
import {
  archiveProviderRevision,
  createS3Client,
  deleteProviderPages,
  getProviderAsset,
  getProviderPage,
  getProviderRevision,
  listProviderAssetNames,
  listProviderPageIds,
  listProviderRevisions,
  putProviderAsset,
  putProviderPage,
} from './s3.js'
import {
  deleteWorkspacePageAssets,
  listWorkspacePageAssets,
  readWorkspacePageAsset,
  saveWorkspacePageAsset,
} from './workspace-assets.js'
import {
  deleteWorkspacePages,
  getWorkspacePage,
  listWorkspacePages,
  listWorkspaceRevisions,
  readWorkspaceRevision,
  saveWorkspacePage,
} from './workspace-pages.js'

function sourceIdFor(workspace) {
  return `backend:${workspace.id}`
}

function withWorkspaceSource(page, workspace) {
  const id = sourceIdFor(workspace)
  return { ...page, storageSourceId: id, storageSourceIds: [id] }
}

export function resolveWorkspaceBackend(workspace, findProvider, userId) {
  const providerId = String(workspace.storageProviderId ?? '').trim()
  if (!providerId) return { kind: 'disk' }
  const provider = findProvider(providerId, userId)
  if (!provider || provider.kind !== 's3') return { kind: 'disk' }
  return { kind: 's3', provider }
}

export async function listPages(workspace, findProvider, userId) {
  const backend = resolveWorkspaceBackend(workspace, findProvider, userId)
  if (backend.kind === 's3') {
    const client = createS3Client(backend.provider.publicConfig, backend.provider.credentials)
    const bucket = String(backend.provider.publicConfig.bucket ?? '')
    const pageIds = await listProviderPageIds(client, bucket)
    const pages = []
    for (const pageId of pageIds) {
      const content = await getProviderPage(client, bucket, pageId)
      pages.push(withWorkspaceSource(parsePage(content), workspace))
    }
    return pages
  }
  return listWorkspacePages(workspace.id, sourceIdFor(workspace))
}

export async function getPage(workspace, pageId, findProvider, userId) {
  const backend = resolveWorkspaceBackend(workspace, findProvider, userId)
  if (backend.kind === 's3') {
    const client = createS3Client(backend.provider.publicConfig, backend.provider.credentials)
    const bucket = String(backend.provider.publicConfig.bucket ?? '')
    const content = await getProviderPage(client, bucket, pageId)
    return withWorkspaceSource(parsePage(content), workspace)
  }
  return getWorkspacePage(workspace.id, pageId, sourceIdFor(workspace))
}

export async function savePage(workspace, page, expectedUpdatedAt, findProvider, userId) {
  const backend = resolveWorkspaceBackend(workspace, findProvider, userId)
  const next = withWorkspaceSource({ ...page, updatedAt: page.updatedAt || new Date().toISOString() }, workspace)
  if (backend.kind === 's3') {
    const client = createS3Client(backend.provider.publicConfig, backend.provider.credentials)
    const bucket = String(backend.provider.publicConfig.bucket ?? '')
    if (expectedUpdatedAt) {
      try {
        const current = await getPage(workspace, page.id, findProvider, userId)
        if (current.updatedAt !== expectedUpdatedAt) {
          const error = new Error('页面已在其他设备更新，请重新载入后再保存')
          error.status = 409
          throw error
        }
        if (current.markdown !== page.markdown || current.title !== page.title) {
          await archiveProviderRevision(client, bucket, current)
        }
      } catch (error) {
        if (error.status === 409) throw error
        if (error?.name !== 'NoSuchKey' && !String(error?.message ?? '').includes('NoSuchKey')) {
          if (expectedUpdatedAt) throw error
        }
      }
    }
    await putProviderPage(client, bucket, next)
    return next
  }
  return saveWorkspacePage(workspace.id, next, expectedUpdatedAt)
}

export async function removePages(workspace, pageIds, findProvider, userId) {
  const backend = resolveWorkspaceBackend(workspace, findProvider, userId)
  if (backend.kind === 's3') {
    const client = createS3Client(backend.provider.publicConfig, backend.provider.credentials)
    await deleteProviderPages(client, String(backend.provider.publicConfig.bucket ?? ''), pageIds ?? [])
    return
  }
  deleteWorkspacePages(workspace.id, pageIds ?? [])
}

export async function listRevisions(workspace, pageId, findProvider, userId) {
  const backend = resolveWorkspaceBackend(workspace, findProvider, userId)
  if (backend.kind === 's3') {
    const client = createS3Client(backend.provider.publicConfig, backend.provider.credentials)
    return listProviderRevisions(client, String(backend.provider.publicConfig.bucket ?? ''), pageId)
  }
  return listWorkspaceRevisions(workspace.id, pageId)
}

export async function readRevision(workspace, pageId, revisionId, findProvider, userId) {
  const backend = resolveWorkspaceBackend(workspace, findProvider, userId)
  if (backend.kind === 's3') {
    const client = createS3Client(backend.provider.publicConfig, backend.provider.credentials)
    const content = await getProviderRevision(
      client,
      String(backend.provider.publicConfig.bucket ?? ''),
      pageId,
      revisionId,
    )
    return withWorkspaceSource(parsePage(content), workspace)
  }
  return readWorkspaceRevision(workspace.id, pageId, revisionId, sourceIdFor(workspace))
}

export async function saveAsset(workspace, pageId, assetName, data, findProvider, userId) {
  const backend = resolveWorkspaceBackend(workspace, findProvider, userId)
  if (backend.kind === 's3') {
    const client = createS3Client(backend.provider.publicConfig, backend.provider.credentials)
    await putProviderAsset(client, String(backend.provider.publicConfig.bucket ?? ''), pageId, assetName, data)
    return assetName
  }
  return saveWorkspacePageAsset(workspace.id, pageId, assetName, data)
}

export async function readAsset(workspace, pageId, assetName, findProvider, userId) {
  const backend = resolveWorkspaceBackend(workspace, findProvider, userId)
  if (backend.kind === 's3') {
    const client = createS3Client(backend.provider.publicConfig, backend.provider.credentials)
    return getProviderAsset(client, String(backend.provider.publicConfig.bucket ?? ''), pageId, assetName)
  }
  return readWorkspacePageAsset(workspace.id, pageId, assetName)
}

export async function listAssets(workspace, pageId, findProvider, userId) {
  const backend = resolveWorkspaceBackend(workspace, findProvider, userId)
  if (backend.kind === 's3') {
    const client = createS3Client(backend.provider.publicConfig, backend.provider.credentials)
    return listProviderAssetNames(client, String(backend.provider.publicConfig.bucket ?? ''), pageId)
  }
  return listWorkspacePageAssets(workspace.id, pageId)
}

export { deleteWorkspacePageAssets, sourceIdFor }
