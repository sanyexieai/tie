import type { StorageSource } from '@/types'
import {
  availabilityForSource,
  buildFileUrl,
  collectFileIdsFromMarkdown,
  collectFileRefsFromMarkdown,
  collectPathRefsFromMarkdown,
  parseFileUrl,
  resolvedSourceId,
  sourceById,
  type ClassifiedLocalLink,
  type LinkAvailability,
  type LinkContext,
} from '@/services/link-runtime'
import { getPlatformAccess } from '@/services/platform-access'
import {
  blobStoreFor,
  type WorkspaceFileKind,
  type WorkspaceFileMode,
  type WorkspaceFileResource,
} from '@/services/storage/blobs'

export { buildFileUrl, collectFileIdsFromMarkdown, collectFileRefsFromMarkdown, collectPathRefsFromMarkdown, parseFileUrl }
export { FILE_URL_PREFIX } from '@/services/link-runtime'
export type { WorkspaceFileKind, WorkspaceFileMode, WorkspaceFileResource }

export function resolveLinkForm(
  mode?: string | null,
  form?: ClassifiedLocalLink['form'] | null,
): ClassifiedLocalLink['form'] | null {
  if (form === 'relative' || form === 'absolute') return form
  if (mode === 'copy' || mode === 'relative') return 'relative'
  if (mode === 'link' || mode === 'absolute') return 'absolute'
  return null
}

/** Style axis per ADR: relative/absolute × ready/missing/offline (directory is only a kind modifier). */
export function fileLinkClass(
  mode: string | null | undefined,
  kind?: string | null,
  availability?: LinkAvailability | null,
  form?: ClassifiedLocalLink['form'] | null,
) {
  const tokens = ['file-link']
  if (kind === 'directory') tokens.push('file-link-directory')
  const resolved = resolveLinkForm(mode, form)
  if (resolved === 'relative') tokens.push('file-link-relative')
  else if (resolved === 'absolute') tokens.push('file-link-absolute')
  if (availability === 'ready') tokens.push('file-link-ready')
  if (availability === 'missing') tokens.push('file-link-missing')
  if (availability === 'offline') tokens.push('file-link-offline')
  if (availability === 'unknown') tokens.push('file-link-unknown')
  return tokens.join(' ')
}

/** Visible status text; healthy links rely on icon color (empty string). */
export function fileLinkLabel(
  mode: string | null | undefined,
  _kind?: string | null,
  availability?: LinkAvailability | null,
  form?: ClassifiedLocalLink['form'] | null,
) {
  const resolved = resolveLinkForm(mode, form)
  if (availability === 'missing') {
    return resolved === 'absolute' ? '找不到' : '缺失'
  }
  if (availability === 'offline') return '源不可用'
  return ''
}

/** Tooltip / aria: form in plain language + optional status. */
export function fileLinkTitle(
  mode: string | null | undefined,
  kind?: string | null,
  availability?: LinkAvailability | null,
  form?: ClassifiedLocalLink['form'] | null,
) {
  const resolved = resolveLinkForm(mode, form)
  const formLabel = resolved === 'relative' ? '库内' : resolved === 'absolute' ? '本机' : (kind === 'directory' ? '目录' : '文件')
  const kindLabel = kind === 'directory' ? '目录' : '文件'
  const base = resolved ? `${formLabel}${kindLabel}` : kindLabel
  const status = fileLinkLabel(mode, kind, availability, form)
  return status ? `${base} · ${status}` : base
}

const cacheBySource = new Map<string, Map<string, WorkspaceFileResource>>()
const relativeExistsBySource = new Map<string, Map<string, boolean>>()

function remember(sourceId: string, items: WorkspaceFileResource[]) {
  cacheBySource.set(sourceId, new Map(items.map((item) => [item.id, item])))
}

function rememberOne(sourceId: string, item: WorkspaceFileResource) {
  const map = cacheBySource.get(sourceId) ?? new Map()
  map.set(item.id, item)
  cacheBySource.set(sourceId, map)
}

export function rememberRelativeExists(sourceId: string, relativePath: string, exists: boolean) {
  const map = relativeExistsBySource.get(sourceId) ?? new Map()
  map.set(relativePath, exists)
  relativeExistsBySource.set(sourceId, map)
}

export function cachedRelativeExists(sourceId: string | null | undefined, relativePath: string): boolean | null {
  if (!sourceId) return null
  const value = relativeExistsBySource.get(sourceId)?.get(relativePath)
  return value === undefined ? null : value
}

export async function listRegisteredFiles(source: StorageSource): Promise<WorkspaceFileResource[]> {
  const list = await blobStoreFor(source).list(source)
  remember(source.id, list)
  return list
}

export async function resolveRegisteredFile(source: StorageSource, fileId: string): Promise<WorkspaceFileResource | null> {
  const cached = cacheBySource.get(source.id)?.get(fileId)
  if (cached) return cached
  const item = await blobStoreFor(source).resolve(source, fileId)
  if (item) rememberOne(source.id, item)
  return item
}

export async function openRegisteredFile(source: StorageSource, fileId: string) {
  const resource = await resolveRegisteredFile(source, fileId)
  if (!resource) throw new Error(`文件资源不存在：${fileId}`)
  if (!resource.exists) {
    throw new Error(
      resource.mode === 'link'
        ? `找不到已登记的文件：${resource.openPath || resource.sourcePath}`
        : `副本缺失：${resource.openPath || resource.storedPath}`,
    )
  }
  const store = blobStoreFor(source)
  if (store.open) {
    await store.open(source, resource)
    return resource
  }
  await getPlatformAccess().openNative(resource.openPath)
  return resource
}

export function cachedFileResource(sourceId: string | null | undefined, fileId: string) {
  if (!sourceId) return null
  return cacheBySource.get(sourceId)?.get(fileId) ?? null
}

export function cachedFileMode(sourceId: string | null | undefined, fileId: string) {
  return cachedFileResource(sourceId, fileId)?.mode ?? null
}

export function cachedFileKind(sourceId: string | null | undefined, fileId: string) {
  return cachedFileResource(sourceId, fileId)?.kind ?? null
}

export function cachedFileExists(sourceId: string | null | undefined, fileId: string): boolean | null {
  const resource = cachedFileResource(sourceId, fileId)
  if (!resource) return null
  return resource.exists
}

export function resourceAvailability(
  link: ClassifiedLocalLink,
  context?: LinkContext | null,
): LinkAvailability {
  const sourceId = resolvedSourceId(link, context)
  const source = sourceById(context?.sources, sourceId)
  if (link.kind === 'relative') {
    const exists = link.relativePath ? cachedRelativeExists(sourceId, link.relativePath) : null
    return availabilityForSource(source, exists)
  }
  if (link.kind === 'absolute') return 'unknown'
  if (!sourceId || !link.fileId) return availabilityForSource(source, null)
  const cached = cacheBySource.get(sourceId)
  if (!cached) return availabilityForSource(source, null)
  const resource = cached.get(link.fileId)
  if (!resource) return 'missing'
  return availabilityForSource(source, resource.exists)
}

export function canRebindRegisteredFile(resource: WorkspaceFileResource | null | undefined) {
  return Boolean(resource && resource.mode === 'link' && resource.exists === false)
}

export async function probeRelativePath(source: StorageSource, relativePath: string): Promise<boolean | null> {
  const rel = relativePath.trim()
  if (!rel) return false
  const cached = cachedRelativeExists(source.id, rel)
  if (cached !== null) return cached
  const exists = await blobStoreFor(source).existsRelative?.(source, rel) ?? null
  if (exists !== null) rememberRelativeExists(source.id, rel, exists)
  return exists
}

export async function rebindRegisteredFile(
  source: StorageSource,
  fileId: string,
  nativePath: string,
): Promise<WorkspaceFileResource> {
  const store = blobStoreFor(source)
  if (!store.rebind) throw new Error('当前存储源不能重新绑定文件')
  const item = await store.rebind(source, fileId, nativePath)
  rememberOne(source.id, item)
  return item
}

export async function ingestRegisteredFile(
  source: StorageSource,
  path: string,
  mode: WorkspaceFileMode = 'link',
  title?: string,
): Promise<WorkspaceFileResource> {
  const item = await blobStoreFor(source).ingest(source, path, mode, title)
  rememberOne(source.id, item)
  return item
}

export async function ingestCopiedBlob(
  source: StorageSource,
  file: File,
): Promise<WorkspaceFileResource> {
  const store = blobStoreFor(source)
  if (!store.ingestBytes) throw new Error('当前存储源不能导入文件副本')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const item = await store.ingestBytes(source, bytes, {
    name: file.name || 'upload.bin',
    mime: file.type || undefined,
    title: file.name || undefined,
  })
  rememberOne(source.id, item)
  if (item.storedPath) rememberRelativeExists(source.id, item.storedPath, true)
  return item
}
