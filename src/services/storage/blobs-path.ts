export const MAX_INGEST_BYTES = 20 * 1024 * 1024

export function fileIdFromFilesRelative(relativePath: string): string | null {
  const rel = relativePath.replace(/\\/g, '/').replace(/^\.\/+/, '')
  const match = rel.match(/^\.tie\/files\/(file_[0-9a-f]+)(?:\/|$)/i)
  return match?.[1] ?? null
}

export function assetRefFromRelative(relativePath: string): { pageId: string; assetName: string } | null {
  const rel = relativePath.replace(/\\/g, '/').replace(/^\.\/+/, '')
  const match = rel.match(/^\.tie\/assets\/([^/]+)\/([^/]+)$/)
  if (!match) return null
  return { pageId: match[1], assetName: match[2] }
}

export function joinWorkspaceRelative(root: string, relativePath: string) {
  const base = String(root || '').trim().replace(/[/\\]+$/, '')
  const rel = String(relativePath || '').trim().replace(/\\/g, '/')
  if (!base || !rel) return ''
  const useWin = /\\/.test(base) || /^[A-Za-z]:/.test(base)
  const sep = useWin ? '\\' : '/'
  return `${base}${sep}${rel.split('/').filter(Boolean).join(sep)}`
}

export function newWorkspaceFileId() {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return `file_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function basenameOf(path: string) {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path
}

export function extensionOf(path: string) {
  const name = basenameOf(path)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index + 1).toLowerCase() : ''
}

export function storedOriginalName(ext: string) {
  const clean = ext.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return clean ? `original.${clean}` : 'original.bin'
}

export function stubPageForBlob(pageId: string, sourceId: string) {
  return {
    id: pageId,
    title: '',
    icon: '',
    parentId: null,
    sortKey: 0,
    markdown: '',
    tags: [] as string[],
    createdAt: '',
    updatedAt: '',
    deletedAt: null as string | null,
    storageSourceId: sourceId,
    storageSourceIds: [sourceId],
  }
}

export function asUint8Array(bytes: unknown): Uint8Array<ArrayBuffer> {
  if (bytes instanceof Uint8Array) return Uint8Array.from(bytes)
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0))
  if (ArrayBuffer.isView(bytes)) {
    return Uint8Array.from(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  }
  if (Array.isArray(bytes)) return Uint8Array.from(bytes)
  throw new Error('二进制数据格式无效')
}

export function assertIngestSize(size: number) {
  if (size > MAX_INGEST_BYTES) {
    throw new Error('文件超过 20 MB，请压缩后重试或改在桌面端登记')
  }
}
