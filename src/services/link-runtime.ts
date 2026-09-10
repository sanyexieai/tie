import type { StorageSource } from '@/types'
import { isWorkspaceFileSource } from '@/services/storage-sources'
import { fileUrlToLocalPath } from '@/services/local-path'

export const FILE_URL_PREFIX = 'tie://file/'
export const PATH_URL_PREFIX = 'tie://path/'
export const ASSET_URL_PREFIX = 'tie://asset/'

export const FILE_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export interface AssetUrlRef {
  pageId: string
  assetName: string
}

export type LinkForm = 'absolute' | 'relative'
export type LocalLinkKind = 'workspace-file' | 'absolute' | 'relative'
export type LinkAvailability = 'ready' | 'missing' | 'offline' | 'unknown'

export interface FileUrlRef {
  fileId: string
  sourceId?: string
}

export interface PathUrlRef {
  relativePath: string
  sourceId?: string
}

export interface ClassifiedLocalLink {
  kind: LocalLinkKind
  form: LinkForm
  href: string
  fileId?: string
  sourceId?: string
  absolutePath?: string
  relativePath?: string
}

export interface LinkContext {
  pageSourceId?: string | null
  sources?: StorageSource[]
}

export type LinkAvailabilityHint = LinkAvailability | null | undefined

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function encodePathSegments(relativePath: string) {
  return relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

function restAfterPrefix(href: string, prefix: string) {
  return href.slice(prefix.length).split(/[?#]/)[0] ?? ''
}

export function isStorageSourceId(value: string) {
  const id = String(value || '').trim()
  if (!id) return false
  if (id === 'source-demo-local') return true
  if (/^src_(local|smb)_[0-9a-f]{16}$/i.test(id)) return true
  if (id.startsWith('s3:') && id.length > 3) return true
  if (id.startsWith('backend:') || id.startsWith('backend-s3:')) return true
  return false
}

export function splitHrefSegments(raw: string) {
  return raw.split('/').filter(Boolean).map(decodeSegment)
}

/** Normalize to workspace-relative POSIX segments; rejects empty / absolute / `..`. */
export function normalizeRelativePath(raw: string): string {
  const text = String(raw || '').trim().replace(/\\/g, '/')
  if (!text) throw new Error('相对路径不能为空')
  if (/^(tie:|file:|https?:|mailto:)/i.test(text)) {
    throw new Error('请输入工作区内的相对路径，不要使用完整 URL')
  }
  if (/^[A-Za-z]:\//.test(text) || text.startsWith('/') || text.startsWith('//')) {
    throw new Error('相对路径不能是绝对路径')
  }
  const parts = text.split('/').filter((part) => part && part !== '.')
  if (!parts.length) throw new Error('相对路径不能为空')
  if (parts.some((part) => part === '..')) {
    throw new Error('相对路径不能包含 ..')
  }
  return parts.join('/')
}

export function parseFileUrl(href: string): FileUrlRef | null {
  if (!href.startsWith(FILE_URL_PREFIX)) return null
  const parts = splitHrefSegments(restAfterPrefix(href, FILE_URL_PREFIX))
  if (parts.length >= 2 && isStorageSourceId(parts[0])) {
    const fileId = parts[1]
    if (!fileId || !FILE_ID_PATTERN.test(fileId)) return null
    return { sourceId: parts[0], fileId }
  }
  if (parts.length === 1 && FILE_ID_PATTERN.test(parts[0])) {
    return { fileId: parts[0] }
  }
  return null
}

export function buildFileUrl(fileId: string, sourceId?: string | null) {
  const id = String(fileId || '').trim()
  const source = String(sourceId || '').trim()
  if (source) return `${FILE_URL_PREFIX}${encodeURIComponent(source)}/${encodeURIComponent(id)}`
  return `${FILE_URL_PREFIX}${id}`
}

export function parsePathUrl(href: string): PathUrlRef | null {
  if (!href.startsWith(PATH_URL_PREFIX)) return null
  const parts = splitHrefSegments(restAfterPrefix(href, PATH_URL_PREFIX))
  if (!parts.length) return null
  try {
    if (parts.length >= 2 && isStorageSourceId(parts[0])) {
      return {
        sourceId: parts[0],
        relativePath: normalizeRelativePath(parts.slice(1).join('/')),
      }
    }
    return { relativePath: normalizeRelativePath(parts.join('/')) }
  } catch {
    return null
  }
}

export function buildPathUrl(relativePath: string, sourceId?: string | null) {
  const normalized = normalizeRelativePath(relativePath)
  const encoded = encodePathSegments(normalized)
  const source = String(sourceId || '').trim()
  if (source) return `${PATH_URL_PREFIX}${encodeURIComponent(source)}/${encoded}`
  return `${PATH_URL_PREFIX}${encoded}`
}

/** Logical workspace path for a page image; adapters map this onto disk / S3 keys. */
export function assetRelativePath(pageId: string, assetName: string) {
  const id = String(pageId || '').trim()
  const name = String(assetName || '').trim()
  if (!id || !name) throw new Error('附件路径无效')
  if (name.includes('/') || name.includes('\\') || name === '..' || name === '.') {
    throw new Error('附件文件名无效')
  }
  return `.tie/assets/${id}/${name}`
}

export function parseAssetUrl(src: string): AssetUrlRef | null {
  if (!src.startsWith(ASSET_URL_PREFIX)) return null
  const rest = restAfterPrefix(src, ASSET_URL_PREFIX)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const pageId = decodeSegment(rest.slice(0, slash))
  const assetName = decodeSegment(rest.slice(slash + 1))
  if (!pageId || !assetName || assetName.includes('/') || assetName.includes('\\')) return null
  return { pageId, assetName }
}

export function buildAssetUrl(pageId: string, assetName: string) {
  return `${ASSET_URL_PREFIX}${pageId}/${assetName}`
}

/** `tie://asset` is a display alias of a relative path; keep it in markdown for images. */
export function assetToPathUrl(src: string, sourceId?: string | null) {
  const parsed = parseAssetUrl(src)
  if (!parsed) return null
  try {
    return buildPathUrl(assetRelativePath(parsed.pageId, parsed.assetName), sourceId)
  } catch {
    return null
  }
}

const TIE_FILE_OR_PATH_HREF = /tie:\/\/(?:file|path)\/[^\s)\]>'"]+/g

/** Rewrite legacy `tie://file/{id}` / `tie://path/{rel}` to include the page source. */
export function rewriteLegacyWorkspaceHrefs(markdown: string, pageSourceId?: string | null) {
  const source = String(pageSourceId || '').trim()
  const text = String(markdown || '')
  if (!source || !isStorageSourceId(source)) return text
  return text.replace(TIE_FILE_OR_PATH_HREF, (href) => {
    const file = parseFileUrl(href)
    if (file) {
      if (file.sourceId) return href
      return buildFileUrl(file.fileId, source)
    }
    const relative = parsePathUrl(href)
    if (relative) {
      if (relative.sourceId) return href
      return buildPathUrl(relative.relativePath, source)
    }
    return href
  })
}

export function migratePageWorkspaceHrefs<T extends { markdown: string; storageSourceId?: string | null }>(page: T): T {
  return {
    ...page,
    markdown: rewriteLegacyWorkspaceHrefs(page.markdown, page.storageSourceId),
  }
}

export function collectFileRefsFromMarkdown(markdown: string): FileUrlRef[] {
  const refs: FileUrlRef[] = []
  const seen = new Set<string>()
  const pattern = /\]\(tie:\/\/file\/([^)\s]+)\)/g
  for (const match of markdown.matchAll(pattern)) {
    const parsed = parseFileUrl(`${FILE_URL_PREFIX}${match[1]}`)
    if (!parsed) continue
    const key = `${parsed.sourceId ?? ''}::${parsed.fileId}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(parsed)
  }
  return refs
}

export function collectFileIdsFromMarkdown(markdown: string) {
  return [...new Set(collectFileRefsFromMarkdown(markdown).map((item) => item.fileId))]
}

export function collectPathRefsFromMarkdown(markdown: string): PathUrlRef[] {
  const refs: PathUrlRef[] = []
  const seen = new Set<string>()
  const pattern = /\]\(tie:\/\/path\/([^)\s]+)\)/g
  for (const match of markdown.matchAll(pattern)) {
    const parsed = parsePathUrl(`${PATH_URL_PREFIX}${match[1]}`)
    if (!parsed) continue
    const key = `${parsed.sourceId ?? ''}::${parsed.relativePath}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(parsed)
  }
  return refs
}

export function classifyLocalLink(href: string): ClassifiedLocalLink | null {
  const trimmed = String(href || '').trim()
  if (!trimmed) return null
  // Images keep the asset alias in markdown; do not treat them as file chips.
  if (parseAssetUrl(trimmed)) return null

  const file = parseFileUrl(trimmed)
  if (file) {
    return {
      kind: 'workspace-file',
      form: 'absolute',
      href: trimmed,
      fileId: file.fileId,
      sourceId: file.sourceId,
    }
  }

  const relative = parsePathUrl(trimmed)
  if (relative) {
    return {
      kind: 'relative',
      form: 'relative',
      href: trimmed,
      sourceId: relative.sourceId,
      relativePath: relative.relativePath,
    }
  }

  const absolutePath = fileUrlToLocalPath(trimmed)
  if (absolutePath) {
    return {
      kind: 'absolute',
      form: 'absolute',
      href: trimmed,
      absolutePath,
    }
  }

  return null
}

export function resolvedSourceId(link: ClassifiedLocalLink, context?: LinkContext | null) {
  return link.sourceId || context?.pageSourceId || null
}

export function sourceById(sources: StorageSource[] | undefined, sourceId: string | null | undefined) {
  if (!sourceId || !sources?.length) return undefined
  return sources.find((item) => item.id === sourceId)
}

export function fileRootForSource(source: StorageSource | null | undefined) {
  if (!source || !isWorkspaceFileSource(source) || !source.path) return null
  return source.path
}

export function resolveFileRoot(link: ClassifiedLocalLink, context?: LinkContext | null) {
  const sourceId = resolvedSourceId(link, context)
  return fileRootForSource(sourceById(context?.sources, sourceId))
}

export function availabilityForSource(
  source: StorageSource | null | undefined,
  exists?: boolean | null,
): LinkAvailability {
  if (!source) return 'offline'
  if (source.available === false) return 'offline'
  if (isWorkspaceFileSource(source) && !fileRootForSource(source)) return 'offline'
  if (exists === true) return 'ready'
  if (exists === false) return 'missing'
  return 'unknown'
}

/** True when absPath is strictly inside root; returns POSIX relative path. */
export function relativePathIfInsideRoot(root: string, absPath: string): string | null {
  const rootText = String(root || '').trim()
  const absText = String(absPath || '').trim()
  if (!rootText || !absText) return null
  if (/^content:\/\//i.test(absText)) return null
  const useWin = /\\/.test(rootText) || /^[A-Za-z]:/.test(rootText) || /^[A-Za-z]:/.test(absText)
  const parts = (value: string) => value.replace(/\\/g, '/').split('/').filter(Boolean)
  const rootParts = parts(rootText)
  const absParts = parts(absText)
  if (!rootParts.length || absParts.length <= rootParts.length) return null
  const equal = (left: string, right: string) => (useWin ? left.toLowerCase() === right.toLowerCase() : left === right)
  for (let index = 0; index < rootParts.length; index += 1) {
    if (!equal(rootParts[index], absParts[index])) return null
  }
  return absParts.slice(rootParts.length).join('/')
}

const FILE_PROTOCOL_HREF = /file:\/\/[^\s)\]>'"]+/gi

export function collectFileProtocolHrefs(text: string) {
  const matches = String(text || '').match(FILE_PROTOCOL_HREF) ?? []
  return [...new Set(matches)]
}

export function replaceFileProtocolHrefs(text: string, replaceHref: (href: string) => string) {
  return String(text || '').replace(FILE_PROTOCOL_HREF, (href) => replaceHref(href))
}

export function pastedTextToHtml(text: string) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const linked = escaped
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s>])((?:tie|https?):\/\/[^\s<]+)/g, '$1<a href="$2">$2</a>')
  return linked.replace(/\n/g, '<br>')
}
