import type { StorageSource } from '@/types'
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
} from '@/services/storage/blobs-path'
import type { SourceBlobStore, WorkspaceFileResource } from '@/services/storage/blobs'

const DB_NAME = 'tie-demo-blobs'
const STORE_NAME = 'blobs'
const INDEX_KEY = 'tie-demo-files-index-v1'

const memoryBlobs = new Map<string, Uint8Array>()
let memoryIndex: WorkspaceFileResource[] = []
let indexHydrated = false

function cloneBytes(data: Uint8Array) {
  return Uint8Array.from(data)
}

function fileKey(fileId: string) {
  return `file:${fileId}`
}

function assetKey(pageId: string, assetName: string) {
  return `asset:${pageId}:${assetName}`
}

function hydrateIndex() {
  if (indexHydrated) return
  indexHydrated = true
  if (typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) memoryIndex = parsed as WorkspaceFileResource[]
  } catch {
    memoryIndex = []
  }
}

function persistIndex() {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(memoryIndex))
  } catch {
    // quota / private mode
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no indexedDB'))
      return
    }
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
  })
}

async function putBlob(key: string, data: Uint8Array) {
  const copy = cloneBytes(data)
  memoryBlobs.set(key, copy)
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'))
      tx.objectStore(STORE_NAME).put(copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength), key)
    })
    db.close()
  } catch {
    // memory-only fallback (tests / private mode)
  }
}

async function getBlob(key: string): Promise<Uint8Array | null> {
  const cached = memoryBlobs.get(key)
  if (cached) return cloneBytes(cached)
  try {
    const db = await openDb()
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('indexedDB read failed'))
    })
    db.close()
    if (value == null) return null
    const bytes = cloneBytes(asUint8Array(value))
    memoryBlobs.set(key, bytes)
    return cloneBytes(bytes)
  } catch {
    return null
  }
}

function rememberResource(resource: WorkspaceFileResource) {
  hydrateIndex()
  memoryIndex = [...memoryIndex.filter((item) => item.id !== resource.id), resource]
  persistIndex()
}

function downloadBytes(fileName: string, data: Uint8Array) {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('当前环境不能下载文件')
  }
  const url = URL.createObjectURL(new Blob([asUint8Array(data)]))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

function resourceFromBytes(
  source: StorageSource,
  bytes: Uint8Array,
  options: { name: string; mime?: string; title?: string },
): WorkspaceFileResource {
  const name = options.name.trim() || 'upload.bin'
  const ext = extensionOf(name)
  const id = newWorkspaceFileId()
  const stored = `.tie/files/${id}/${storedOriginalName(ext)}`
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
    locator: {
      type: 'display',
      displayPath: name,
    },
  }, { sourceId: source.id, now })
  return {
    ...fileMetaToJson(meta),
    id: meta.id,
    title: meta.title,
    kind: meta.kind,
    mode: meta.mode,
    ext: meta.ext,
    mime: meta.mime,
    size: meta.size,
    sourcePath: meta.sourcePath,
    storedPath: meta.storedPath,
    openPath: stored,
    exists: true,
    updatedAt: meta.updatedAt,
  } as WorkspaceFileResource
}

export function resetBrowserBlobStoreForTests() {
  memoryBlobs.clear()
  memoryIndex = []
  indexHydrated = true
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(INDEX_KEY)
    } catch {
      // ignore
    }
  }
}

export const browserBlobStore: SourceBlobStore = {
  canRegister: true,
  async list() {
    hydrateIndex()
    return [...memoryIndex]
  },
  async resolve(_source, fileId) {
    hydrateIndex()
    const id = fileId.trim()
    if (!id) return null
    return memoryIndex.find((item) => item.id === id) ?? null
  },
  async ingest() {
    throw new Error('浏览器演示模式请选择文件导入副本，不能登记本机路径')
  },
  async ingestBytes(source, bytes, options) {
    assertIngestSize(bytes.byteLength)
    const resource = resourceFromBytes(source, bytes, options)
    await putBlob(fileKey(resource.id), bytes)
    rememberResource(resource)
    return resource
  },
  async existsRelative(_source, relativePath) {
    const fileId = fileIdFromFilesRelative(relativePath)
    if (fileId) {
      const blob = await getBlob(fileKey(fileId))
      if (blob) return true
      hydrateIndex()
      return memoryIndex.some((item) => item.id === fileId && item.exists)
    }
    const asset = assetRefFromRelative(relativePath)
    if (asset) return Boolean(await getBlob(assetKey(asset.pageId, asset.assetName)))
    return false
  },
  async readRelative(_source, relativePath) {
    const fileId = fileIdFromFilesRelative(relativePath)
    if (fileId) {
      const data = await getBlob(fileKey(fileId))
      if (!data) throw new Error('副本不存在')
      return data
    }
    const asset = assetRefFromRelative(relativePath)
    if (asset) {
      const data = await getBlob(assetKey(asset.pageId, asset.assetName))
      if (!data) throw new Error('附件不存在')
      return data
    }
    throw new Error('演示源没有该相对路径')
  },
  async writeRelative(_source, relativePath, data) {
    assertIngestSize(data.byteLength)
    const asset = assetRefFromRelative(relativePath)
    if (asset) {
      await putBlob(assetKey(asset.pageId, asset.assetName), data)
      return
    }
    const fileId = fileIdFromFilesRelative(relativePath)
    if (fileId) {
      await putBlob(fileKey(fileId), data)
      return
    }
    throw new Error('演示源只能写入页面附件或已导入副本')
  },
  async open(_source, resource) {
    if (resource.mode !== 'copy') {
      throw new Error('浏览器演示模式不能打开本机路径')
    }
    const data = await getBlob(fileKey(resource.id))
    if (!data) throw new Error('副本不存在')
    downloadBytes(basenameOf(resource.storedPath || resource.title || 'download.bin'), data)
  },
  async openRelative(source, relativePath) {
    const data = await this.readRelative!(source, relativePath)
    downloadBytes(basenameOf(relativePath), data)
  },
}
