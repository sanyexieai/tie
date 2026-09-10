/** Canonical on-disk shape for `.tie/files/{id}/meta.json`. Extra fields are preserved. */

export type FileKind = 'file' | 'directory'
export type FileMode = 'copy' | 'link'
export type FileLocatorType = 'desktop' | 'android' | 'display'

export interface FileLocator {
  type: FileLocatorType
  desktopPath?: string
  androidUri?: string
  displayPath: string
}

export interface FileMeta {
  id: string
  title: string
  kind: FileKind
  mode: FileMode
  sourceId?: string
  mime: string
  ext: string
  size: number
  sourcePath: string
  storedPath: string
  locator: FileLocator
  contentHash?: string | null
  sha256?: string | null
  createdAt: string
  updatedAt: string
  preview?: string | null
  entryCount?: { files?: number; dirs?: number } | null
  mtime?: string | null
}

function text(value: unknown) {
  return String(value ?? '').trim()
}

function looksLikeContentUri(value: string) {
  return /^content:\/\//i.test(value)
}

function locatorFrom(raw: Record<string, unknown>, sourcePath: string, storedPath: string): FileLocator {
  const existing = raw.locator && typeof raw.locator === 'object' ? raw.locator as Record<string, unknown> : null
  const androidUri = text(existing?.androidUri)
    || (looksLikeContentUri(sourcePath) ? sourcePath : '')
    || (looksLikeContentUri(storedPath) ? storedPath : '')
    || undefined
  const desktopPath = text(existing?.desktopPath)
    || (androidUri || looksLikeContentUri(sourcePath) ? '' : sourcePath)
  const displayPath = text(existing?.displayPath) || desktopPath || text(raw.title) || androidUri || storedPath
  const type = text(existing?.type) === 'android' || (Boolean(androidUri) && !desktopPath) ? 'android'
    : text(existing?.type) === 'display' ? 'display'
    : 'desktop'
  const locator: FileLocator = { type, displayPath }
  if (desktopPath) locator.desktopPath = desktopPath
  if (androidUri) locator.androidUri = androidUri
  return locator
}

export function normalizeFileMeta(
  raw: Record<string, unknown> | null | undefined,
  options: { sourceId?: string | null; now?: string } = {},
): FileMeta {
  const input = raw && typeof raw === 'object' ? raw : {}
  const now = options.now || new Date().toISOString()
  const id = text(input.id)
  const mode: FileMode = input.mode === 'copy' ? 'copy' : 'link'
  const kind: FileKind = input.kind === 'directory' ? 'directory' : 'file'
  const locatorInput = input.locator && typeof input.locator === 'object'
    ? input.locator as Record<string, unknown>
    : null
  const sourcePath = text(input.sourcePath)
    || text(locatorInput?.desktopPath)
    || text(locatorInput?.androidUri)
  const storedPath = text(input.storedPath) || (mode === 'link' ? sourcePath : '')
  const sourceId = text(input.sourceId) || text(options.sourceId) || undefined
  const hash = text(input.contentHash) || text(input.sha256) || null
  const meta: FileMeta = {
    id,
    title: text(input.title) || id,
    kind,
    mode,
    mime: text(input.mime) || 'application/octet-stream',
    ext: text(input.ext),
    size: Number(input.size || 0) || 0,
    sourcePath,
    storedPath,
    locator: locatorFrom(input, sourcePath, storedPath),
    contentHash: hash,
    sha256: hash,
    createdAt: text(input.createdAt) || now,
    updatedAt: text(input.updatedAt) || now,
  }
  if (sourceId) meta.sourceId = sourceId
  if (input.preview != null) meta.preview = typeof input.preview === 'string' ? input.preview : null
  if (input.entryCount != null) meta.entryCount = input.entryCount as FileMeta['entryCount']
  if (input.mtime != null) meta.mtime = text(input.mtime) || null
  return meta
}

export function fileMetaToJson(meta: FileMeta): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: meta.id,
    title: meta.title,
    kind: meta.kind,
    mode: meta.mode,
    mime: meta.mime,
    ext: meta.ext,
    size: meta.size,
    sourcePath: meta.sourcePath,
    storedPath: meta.storedPath,
    locator: meta.locator,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
  if (meta.sourceId) json.sourceId = meta.sourceId
  if (meta.contentHash) json.contentHash = meta.contentHash
  if (meta.sha256) json.sha256 = meta.sha256
  if (meta.preview != null) json.preview = meta.preview
  if (meta.entryCount != null) json.entryCount = meta.entryCount
  if (meta.mtime != null) json.mtime = meta.mtime
  return json
}
