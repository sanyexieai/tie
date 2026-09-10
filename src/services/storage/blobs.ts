import { invoke } from '@tauri-apps/api/core'
import type { StorageSource } from '@/types'
import { fileRootForSource } from '@/services/link-runtime'
import { backendS3BlobStore, backendWorkspaceBlobStore, s3BlobStore } from '@/services/storage/blobs-remote'
import { browserBlobStore } from '@/services/storage/blobs-browser'
import {
  asUint8Array,
  assertIngestSize,
  assetRefFromRelative,
  joinWorkspaceRelative,
  stubPageForBlob,
} from '@/services/storage/blobs-path'

export type WorkspaceFileMode = 'copy' | 'link'
export type WorkspaceFileKind = 'file' | 'directory'

export interface WorkspaceFileResource {
  id: string
  title: string
  kind?: WorkspaceFileKind | string
  mode: WorkspaceFileMode | string
  ext: string
  mime: string
  size: number
  sourcePath: string
  storedPath: string
  openPath: string
  exists: boolean
  updatedAt: string
}

export interface IngestBytesOptions {
  name: string
  mime?: string
  title?: string
}

export interface SourceBlobStore {
  readonly canRegister: boolean
  list(source: StorageSource): Promise<WorkspaceFileResource[]>
  resolve(source: StorageSource, fileId: string): Promise<WorkspaceFileResource | null>
  ingest(
    source: StorageSource,
    nativePath: string,
    mode?: WorkspaceFileMode,
    title?: string,
  ): Promise<WorkspaceFileResource>
  ingestBytes?(
    source: StorageSource,
    bytes: Uint8Array,
    options: IngestBytesOptions,
  ): Promise<WorkspaceFileResource>
  rebind?(source: StorageSource, fileId: string, nativePath: string): Promise<WorkspaceFileResource>
  existsRelative?(source: StorageSource, relativePath: string): Promise<boolean | null>
  readRelative?(source: StorageSource, relativePath: string): Promise<Uint8Array>
  writeRelative?(source: StorageSource, relativePath: string, data: Uint8Array): Promise<void>
  open?(source: StorageSource, resource: WorkspaceFileResource): Promise<void>
  openRelative?(source: StorageSource, relativePath: string): Promise<void>
}

export { fileIdFromFilesRelative } from '@/services/storage/blobs-path'
export { browserBlobStore, resetBrowserBlobStoreForTests } from '@/services/storage/blobs-browser'

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function requireFileRoot(source: StorageSource) {
  const root = fileRootForSource(source)
  if (!root) throw new Error('当前存储源不是本地或 SMB，无法访问工作区文件')
  return root
}

function unavailableStore(message: string): SourceBlobStore {
  return {
    canRegister: false,
    async list() {
      return []
    },
    async resolve() {
      return null
    },
    async ingest() {
      throw new Error(message)
    },
    async existsRelative() {
      return null
    },
  }
}

export const remoteBlobStore = unavailableStore('远程存储源尚未同步文件登记，暂不能在此源登记或打开本机文件。')

async function ingestBytesViaTemp(
  store: SourceBlobStore,
  source: StorageSource,
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
  return store.ingest(source, path, 'copy', options.title?.trim() || fileName)
}

export const fileBlobStore: SourceBlobStore = {
  canRegister: true,
  async list(source) {
    if (!isTauriRuntime()) return []
    const root = requireFileRoot(source)
    return invoke<WorkspaceFileResource[]>('list_workspace_files', { root })
  },
  async resolve(source, fileId) {
    if (!isTauriRuntime()) return null
    const root = requireFileRoot(source)
    const id = fileId.trim()
    if (!id) return null
    try {
      return await invoke<WorkspaceFileResource>('resolve_workspace_file', { root, fileId: id })
    } catch {
      return null
    }
  },
  async ingest(source, nativePath, mode = 'link', title) {
    if (!isTauriRuntime()) throw new Error('仅桌面或 Android 客户端可登记本地文件')
    const root = requireFileRoot(source)
    const path = nativePath.trim()
    if (!path) throw new Error('路径不能为空')
    return invoke<WorkspaceFileResource>('ingest_workspace_file', {
      root,
      path,
      mode,
      title: title?.trim() || null,
      sourceId: source.id,
    })
  },
  async ingestBytes(source, bytes, options) {
    return ingestBytesViaTemp(this, source, bytes, options)
  },
  async rebind(source, fileId, nativePath) {
    if (!isTauriRuntime()) throw new Error('仅桌面或 Android 客户端可重新绑定文件')
    const root = requireFileRoot(source)
    const path = nativePath.trim()
    const id = fileId.trim()
    if (!path) throw new Error('路径不能为空')
    if (!id) throw new Error('fileId 无效')
    return invoke<WorkspaceFileResource>('ingest_workspace_file', {
      root,
      path,
      mode: 'link',
      title: null,
      sourceId: source.id,
      fileId: id,
    })
  },
  async existsRelative(source, relativePath) {
    if (!isTauriRuntime()) return null
    const root = requireFileRoot(source)
    const full = joinWorkspaceRelative(root, relativePath)
    if (!full) return false
    return invoke<boolean>('native_path_exists', { path: full })
  },
  async readRelative(source, relativePath) {
    if (!isTauriRuntime()) throw new Error('仅桌面或 Android 客户端可读取本地文件')
    const asset = assetRefFromRelative(relativePath)
    if (asset) {
      return asUint8Array(await invoke<unknown>('read_file_page_asset', {
        page: stubPageForBlob(asset.pageId, source.id),
        assetName: asset.assetName,
      }))
    }
    const root = requireFileRoot(source)
    const full = joinWorkspaceRelative(root, relativePath)
    if (!full) throw new Error('相对路径无效')
    return asUint8Array(await invoke<unknown>('read_native_file_bytes', { path: full }))
  },
  async writeRelative(source, relativePath, data) {
    if (!isTauriRuntime()) throw new Error('仅桌面或 Android 客户端可写入本地文件')
    const asset = assetRefFromRelative(relativePath)
    if (!asset) throw new Error('本地存储源只能从此处写入页面附件')
    await invoke<string>('save_file_page_asset', {
      page: stubPageForBlob(asset.pageId, source.id),
      fileName: asset.assetName,
      data: Array.from(data),
    })
  },
}

export function blobStoreFor(source: StorageSource): SourceBlobStore {
  if (source.id === 'source-demo-local') return browserBlobStore
  if (source.id.startsWith('backend-s3:')) return backendS3BlobStore
  if (source.id.startsWith('backend:')) return backendWorkspaceBlobStore
  if (source.kind === 's3' || source.id.startsWith('s3:')) return s3BlobStore
  if (source.kind === 'local' || source.kind === 'smb') return fileBlobStore
  return remoteBlobStore
}
