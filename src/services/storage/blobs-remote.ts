import { invoke } from '@tauri-apps/api/core'
import {
  backendService,
  parseBackendProviderId,
  parseBackendWorkspaceId,
} from '@/services/backend'
import { getPlatformAccess } from '@/services/platform-access'
import { s3ConnectionForSource } from '@/services/s3'
import type { IngestBytesOptions, SourceBlobStore, WorkspaceFileResource } from '@/services/storage/blobs'
import { fileMetaToJson, normalizeFileMeta } from '@/services/storage/file-meta'
import {
  asUint8Array,
  assertIngestSize,
  assetRefFromRelative,
  basenameOf,
  extensionOf,
  fileIdFromFilesRelative,
  newWorkspaceFileId,
  storedOriginalName,
  stubPageForBlob,
} from '@/services/storage/blobs-path'

function isTauriRuntime() {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

async function existsCopyOrAsset(
  store: Pick<SourceBlobStore, 'resolve'>,
  source: Parameters<SourceBlobStore['resolve']>[0],
  relativePath: string,
  listAssets?: (pageId: string) => Promise<string[]>,
): Promise<boolean | null> {
  const fileId = fileIdFromFilesRelative(relativePath)
  if (fileId) {
    const resource = await store.resolve(source, fileId)
    if (!resource) return false
    return Boolean(resource.exists)
  }
  const asset = assetRefFromRelative(relativePath)
  if (asset && listAssets) {
    try {
      const names = await listAssets(asset.pageId)
      return names.includes(asset.assetName)
    } catch {
      return false
    }
  }
  return null
}

function storedName(ext: string) {
  return storedOriginalName(ext)
}

async function readNativeBytes(path: string) {
  if (!isTauriRuntime()) throw new Error('仅桌面或 Android 客户端可导入本机文件')
  const data = await invoke<number[]>('read_native_file_bytes', { path })
  return new Uint8Array(data)
}

async function writeTempAndOpen(fileName: string, data: Uint8Array) {
  if (!isTauriRuntime()) throw new Error('仅桌面或 Android 客户端可打开远程副本')
  const path = await invoke<string>('write_temp_file_bytes', {
    fileName,
    data: Array.from(data),
  })
  await getPlatformAccess().openNative(path)
}

async function ingestBytesViaTempFile(
  ingest: (nativePath: string, title?: string) => Promise<WorkspaceFileResource>,
  bytes: Uint8Array,
  options: IngestBytesOptions,
) {
  if (!isTauriRuntime()) throw new Error('仅桌面或 Android 客户端可导入本机文件')
  assertIngestSize(bytes.byteLength)
  const fileName = options.name.trim() || 'upload.bin'
  const path = await invoke<string>('write_temp_file_bytes', {
    fileName,
    data: Array.from(bytes),
  })
  return ingest(path, options.title?.trim() || fileName)
}

function s3Store(): SourceBlobStore {
  return {
    canRegister: true,
    async list(source) {
      if (!isTauriRuntime()) return []
      try {
        const list = await invoke<WorkspaceFileResource[]>('list_s3_workspace_files', {
          connection: s3ConnectionForSource(source.id),
        })
        return list
      } catch {
        return []
      }
    },
    async resolve(source, fileId) {
      if (!isTauriRuntime()) return null
      try {
        return await invoke<WorkspaceFileResource>('resolve_s3_workspace_file', {
          connection: s3ConnectionForSource(source.id),
          fileId,
        })
      } catch {
        return null
      }
    },
    async ingest(source, nativePath, mode = 'link', title) {
      if (!isTauriRuntime()) throw new Error('仅桌面或 Android 客户端可登记文件')
      return invoke<WorkspaceFileResource>('ingest_s3_workspace_file', {
        connection: s3ConnectionForSource(source.id),
        path: nativePath,
        mode,
        title: title?.trim() || null,
        sourceId: source.id,
      })
    },
    async ingestBytes(source, bytes, options) {
      return ingestBytesViaTempFile(
        (nativePath, title) => this.ingest(source, nativePath, 'copy', title),
        bytes,
        options,
      )
    },
    async rebind(source, fileId, nativePath) {
      if (!isTauriRuntime()) throw new Error('仅桌面或 Android 客户端可重新绑定文件')
      return invoke<WorkspaceFileResource>('ingest_s3_workspace_file', {
        connection: s3ConnectionForSource(source.id),
        path: nativePath,
        mode: 'link',
        title: null,
        sourceId: source.id,
        fileId,
      })
    },
    async existsRelative(source, relativePath) {
      return existsCopyOrAsset(this, source, relativePath, async (pageId) => {
        if (!isTauriRuntime()) return []
        return invoke<string[]>('list_s3_page_assets', {
          connection: s3ConnectionForSource(source.id),
          page: stubPageForBlob(pageId, source.id),
        })
      })
    },
    async readRelative(source, relativePath) {
      if (!isTauriRuntime()) throw new Error('仅桌面或 Android 客户端可读取 S3 附件')
      const asset = assetRefFromRelative(relativePath)
      if (!asset) throw new Error('S3 只能从此处读取页面附件')
      return asUint8Array(await invoke<unknown>('read_s3_page_asset', {
        connection: s3ConnectionForSource(source.id),
        page: stubPageForBlob(asset.pageId, source.id),
        assetName: asset.assetName,
      }))
    },
    async writeRelative(source, relativePath, data) {
      if (!isTauriRuntime()) throw new Error('仅桌面或 Android 客户端可写入 S3 附件')
      const asset = assetRefFromRelative(relativePath)
      if (!asset) throw new Error('S3 只能从此处写入页面附件')
      await invoke<string>('save_s3_page_asset', {
        connection: s3ConnectionForSource(source.id),
        page: stubPageForBlob(asset.pageId, source.id),
        fileName: asset.assetName,
        data: Array.from(data),
      })
    },
    async open(source, resource) {
      if (!isTauriRuntime()) throw new Error('仅桌面或 Android 客户端可打开文件')
      const path = await invoke<string>('prepare_s3_workspace_file', {
        connection: s3ConnectionForSource(source.id),
        fileId: resource.id,
      })
      await getPlatformAccess().openNative(path)
    },
    async openRelative(source, relativePath) {
      const fileId = fileIdFromFilesRelative(relativePath)
      if (!fileId) throw new Error('远程存储源只能打开已导入的工作区副本')
      const resource = await this.resolve(source, fileId)
      if (!resource) throw new Error(`文件资源不存在：${fileId}`)
      await this.open!(source, resource)
    },
  }
}

function httpFileStore(kind: 'workspace' | 'provider'): SourceBlobStore {
  return {
    canRegister: true,
    async list(source) {
      const profile = backendService.loadProfile()
      if (!profile.accessToken) return []
      try {
        if (kind === 'workspace') {
          return backendService.listWorkspaceFiles(profile, parseBackendWorkspaceId(source.id))
        }
        return backendService.listProviderFiles(profile, parseBackendProviderId(source.id))
      } catch {
        return []
      }
    },
    async resolve(source, fileId) {
      const profile = backendService.loadProfile()
      if (!profile.accessToken) return null
      try {
        const resource = kind === 'workspace'
          ? await backendService.getWorkspaceFile(profile, parseBackendWorkspaceId(source.id), fileId)
          : await backendService.getProviderFile(profile, parseBackendProviderId(source.id), fileId)
        if (resource.mode === 'link') {
          resource.exists = await getPlatformAccess().exists(resource.openPath || resource.sourcePath)
        }
        return resource
      } catch {
        return null
      }
    },
    async ingest(source, nativePath, mode = 'link', title) {
      if (mode === 'copy' && !isTauriRuntime()) {
        throw new Error('仅桌面或 Android 客户端可导入本机文件')
      }
      const profile = backendService.loadProfile()
      if (!profile.accessToken) throw new Error('请先连接自定义后台')
      const path = nativePath.trim()
      if (!path) throw new Error('路径不能为空')
      const stat = isTauriRuntime()
        ? await invoke<{ exists: boolean; isDirectory: boolean; size: number }>('native_path_stat', { path })
        : { exists: true, isDirectory: false, size: 0 }
      if (mode === 'copy' && stat.isDirectory) {
        throw new Error('远程存储源不能导入目录副本，请改用登记')
      }
      const ext = stat.isDirectory ? 'dir' : extensionOf(path)
      const id = newWorkspaceFileId()
      const stored = mode === 'copy' ? `.tie/files/${id}/${storedName(ext)}` : path
      const now = new Date().toISOString()
      const meta = normalizeFileMeta({
        id,
        title: title?.trim() || basenameOf(path),
        kind: stat.isDirectory ? 'directory' : 'file',
        mode,
        ext,
        mime: stat.isDirectory ? 'inode/directory' : 'application/octet-stream',
        size: stat.size,
        sourcePath: path,
        storedPath: stored,
        createdAt: now,
        updatedAt: now,
      }, { sourceId: source.id, now })
      const payload = {
        ...fileMetaToJson(meta),
        openPath: mode === 'link' ? path : stored,
        exists: mode === 'link',
      } as WorkspaceFileResource
      if (mode === 'copy') {
        const data = await readNativeBytes(path)
        payload.size = data.byteLength
        payload.kind = 'file'
        if (kind === 'workspace') {
          await backendService.uploadWorkspaceFileBlob(
            profile,
            parseBackendWorkspaceId(source.id),
            id,
            storedName(ext),
            data,
          )
        } else {
          await backendService.uploadProviderFileBlob(
            profile,
            parseBackendProviderId(source.id),
            id,
            storedName(ext),
            data,
          )
        }
      }
      if (kind === 'workspace') {
        return backendService.upsertWorkspaceFile(profile, parseBackendWorkspaceId(source.id), payload)
      }
      return backendService.upsertProviderFile(profile, parseBackendProviderId(source.id), payload)
    },
    async ingestBytes(source, bytes, options) {
      assertIngestSize(bytes.byteLength)
      const profile = backendService.loadProfile()
      if (!profile.accessToken) throw new Error('请先连接自定义后台')
      const name = options.name.trim() || 'upload.bin'
      const ext = extensionOf(name)
      const id = newWorkspaceFileId()
      const stored = `.tie/files/${id}/${storedName(ext)}`
      const now = new Date().toISOString()
      const meta = normalizeFileMeta({
        id,
        title: options.title?.trim() || name,
        kind: 'file',
        mode: 'copy',
        ext,
        mime: options.mime?.trim() || 'application/octet-stream',
        size: bytes.byteLength,
        sourcePath: name,
        storedPath: stored,
        createdAt: now,
        updatedAt: now,
        locator: { type: 'display', displayPath: name },
      }, { sourceId: source.id, now })
      if (kind === 'workspace') {
        await backendService.uploadWorkspaceFileBlob(
          profile,
          parseBackendWorkspaceId(source.id),
          id,
          storedName(ext),
          bytes,
        )
        return backendService.upsertWorkspaceFile(profile, parseBackendWorkspaceId(source.id), {
          ...fileMetaToJson(meta),
          openPath: stored,
          exists: true,
        } as WorkspaceFileResource)
      }
      await backendService.uploadProviderFileBlob(
        profile,
        parseBackendProviderId(source.id),
        id,
        storedName(ext),
        bytes,
      )
      return backendService.upsertProviderFile(profile, parseBackendProviderId(source.id), {
        ...fileMetaToJson(meta),
        openPath: stored,
        exists: true,
      } as WorkspaceFileResource)
    },
    async rebind(source, fileId, nativePath) {
      const existing = await this.resolve(source, fileId)
      if (!existing) throw new Error(`文件资源不存在：${fileId}`)
      if (existing.mode !== 'link') throw new Error('副本不能重新绑定，请重新导入')
      const path = nativePath.trim()
      if (!path) throw new Error('路径不能为空')
      const profile = backendService.loadProfile()
      if (!profile.accessToken) throw new Error('请先连接自定义后台')
      const stat = isTauriRuntime()
        ? await invoke<{ exists: boolean; isDirectory: boolean; size: number }>('native_path_stat', { path })
        : { exists: true, isDirectory: false, size: 0 }
      const now = new Date().toISOString()
      const ext = stat.isDirectory ? 'dir' : extensionOf(path)
      const meta = normalizeFileMeta({
        ...existing,
        title: existing.title || basenameOf(path),
        kind: stat.isDirectory ? 'directory' : 'file',
        mode: 'link',
        ext,
        mime: stat.isDirectory ? 'inode/directory' : existing.mime,
        size: stat.size,
        sourcePath: path,
        storedPath: path,
        updatedAt: now,
      }, { sourceId: source.id, now })
      const payload = {
        ...fileMetaToJson(meta),
        openPath: path,
        exists: true,
      } as WorkspaceFileResource
      if (kind === 'workspace') {
        return backendService.upsertWorkspaceFile(profile, parseBackendWorkspaceId(source.id), payload)
      }
      return backendService.upsertProviderFile(profile, parseBackendProviderId(source.id), payload)
    },
    async existsRelative(source, relativePath) {
      return existsCopyOrAsset(this, source, relativePath, async (pageId) => {
        const profile = backendService.loadProfile()
        if (!profile.accessToken) return []
        if (kind === 'workspace') {
          return backendService.listWorkspacePageAssets(profile, parseBackendWorkspaceId(source.id), pageId)
        }
        return backendService.listProviderPageAssets(profile, parseBackendProviderId(source.id), pageId)
      })
    },
    async readRelative(source, relativePath) {
      const profile = backendService.loadProfile()
      if (!profile.accessToken) throw new Error('请先连接自定义后台')
      const asset = assetRefFromRelative(relativePath)
      if (asset) {
        const data = kind === 'workspace'
          ? await backendService.readWorkspacePageAsset(profile, parseBackendWorkspaceId(source.id), asset.pageId, asset.assetName)
          : await backendService.readProviderPageAsset(profile, parseBackendProviderId(source.id), asset.pageId, asset.assetName)
        return asUint8Array(data)
      }
      const fileId = fileIdFromFilesRelative(relativePath)
      if (!fileId) throw new Error('远程存储源只能读取页面附件或已导入副本')
      const data = kind === 'workspace'
        ? await backendService.readWorkspaceFileBlob(profile, parseBackendWorkspaceId(source.id), fileId)
        : await backendService.readProviderFileBlob(profile, parseBackendProviderId(source.id), fileId)
      return asUint8Array(data)
    },
    async writeRelative(source, relativePath, data) {
      const profile = backendService.loadProfile()
      if (!profile.accessToken) throw new Error('请先连接自定义后台')
      const asset = assetRefFromRelative(relativePath)
      if (!asset) throw new Error('远程存储源只能从此处写入页面附件')
      if (kind === 'workspace') {
        await backendService.uploadWorkspacePageAsset(
          profile,
          parseBackendWorkspaceId(source.id),
          asset.pageId,
          asset.assetName,
          data,
        )
        return
      }
      await backendService.uploadProviderPageAsset(
        profile,
        parseBackendProviderId(source.id),
        asset.pageId,
        asset.assetName,
        data,
      )
    },
    async open(source, resource) {
      if (resource.mode === 'link') {
        await getPlatformAccess().openNative(resource.openPath || resource.sourcePath)
        return
      }
      const profile = backendService.loadProfile()
      if (!profile.accessToken) throw new Error('请先连接自定义后台')
      const data = kind === 'workspace'
        ? await backendService.readWorkspaceFileBlob(profile, parseBackendWorkspaceId(source.id), resource.id)
        : await backendService.readProviderFileBlob(profile, parseBackendProviderId(source.id), resource.id)
      await writeTempAndOpen(basenameOf(resource.storedPath || resource.title || 'download.bin'), new Uint8Array(data))
    },
    async openRelative(source, relativePath) {
      const fileId = fileIdFromFilesRelative(relativePath)
      if (!fileId) throw new Error('远程存储源只能打开已导入的工作区副本')
      const resource = await this.resolve(source, fileId)
      if (!resource) throw new Error(`文件资源不存在：${fileId}`)
      await this.open!(source, resource)
    },
  }
}

export const s3BlobStore = s3Store()
export const backendWorkspaceBlobStore = httpFileStore('workspace')
export const backendS3BlobStore = httpFileStore('provider')
