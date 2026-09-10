import {
  cachedFileKind,
  cachedFileMode,
  fileLinkClass as workspaceFileLinkClass,
  ingestRegisteredFile,
  openRegisteredFile,
  resourceAvailability,
} from '@/services/files'
import { getPlatformAccess } from '@/services/platform-access'
import { blobStoreFor } from '@/services/storage/blobs'
import { isCrossSourceLink, sourceChipLabel } from '@/services/link-actions'
import {
  buildFileUrl,
  buildPathUrl,
  classifyLocalLink,
  collectFileProtocolHrefs,
  fileRootForSource,
  migratePageWorkspaceHrefs,
  normalizeRelativePath,
  relativePathIfInsideRoot,
  replaceFileProtocolHrefs,
  resolvedSourceId,
  resolveFileRoot,
  sourceById,
  type ClassifiedLocalLink,
  type LinkContext,
} from '@/services/link-runtime'
import { fileUrlToLocalPath } from '@/services/local-path'
import type { StorageSource } from '@/types'

export {
  buildPathUrl,
  classifyLocalLink,
  FILE_URL_PREFIX,
  normalizeRelativePath,
  parsePathUrl,
  pastedTextToHtml,
  PATH_URL_PREFIX,
  type ClassifiedLocalLink,
  type LinkContext,
  type LocalLinkKind,
} from '@/services/link-runtime'

const LOCAL_LINK_CLASSES = [
  'file-link',
  'file-link-copy',
  'file-link-link',
  'file-link-directory',
  'file-link-absolute',
  'file-link-relative',
  'file-link-ready',
  'file-link-missing',
  'file-link-offline',
  'file-link-unknown',
  'file-link-cross-source',
] as const

/** Join workspace root + relative path using the root's separator style. */
export function resolveRelativeToWorkspace(workspaceRoot: string, relativePath: string): string {
  const root = String(workspaceRoot || '').trim().replace(/[/\\]+$/, '')
  if (!root) throw new Error('当前页面未绑定本地或 SMB 存储源')
  const rel = normalizeRelativePath(relativePath)
  const useWin = /\\/.test(root) || /^[A-Za-z]:/.test(root)
  const sep = useWin ? '\\' : '/'
  return `${root}${sep}${rel.split('/').join(sep)}`
}

export function localLinkClass(
  link: ClassifiedLocalLink,
  options?: LinkContext & { workspaceRoot?: string | null },
): string {
  const availability = resourceAvailability(link, options)
  if (link.kind === 'workspace-file' && link.fileId) {
    const sourceId = resolvedSourceId(link, options)
    const mode = cachedFileMode(sourceId, link.fileId)
    const kind = cachedFileKind(sourceId, link.fileId)
    const form = mode === 'copy' ? 'relative' : 'absolute'
    return workspaceFileLinkClass(mode, kind, availability, form)
  }
  if (link.kind === 'absolute') return workspaceFileLinkClass(null, null, availability, 'absolute')
  if (link.kind === 'relative') return workspaceFileLinkClass(null, null, availability, 'relative')
  return 'file-link'
}

export function localLinkLabel(link: ClassifiedLocalLink): string {
  if (link.form === 'relative' || link.kind === 'relative') return '库内'
  return '本机'
}

export function clearLocalLinkClasses(anchor: HTMLAnchorElement) {
  for (const token of LOCAL_LINK_CLASSES) {
    anchor.classList.remove(token)
  }
  delete anchor.dataset.fileMode
  delete anchor.dataset.fileKind
  delete anchor.dataset.localLink
  delete anchor.dataset.linkForm
  delete anchor.dataset.linkAvail
  delete anchor.dataset.linkSource
  delete anchor.dataset.linkSourceName
  delete anchor.dataset.linkCross
}

export function applyLocalLinkClasses(
  anchor: HTMLAnchorElement,
  href: string,
  options?: LinkContext & { workspaceRoot?: string | null },
) {
  const link = classifyLocalLink(href)
  clearLocalLinkClasses(anchor)
  if (!link) return false
  for (const token of localLinkClass(link, options).split(/\s+/)) {
    if (token) anchor.classList.add(token)
  }
  const sourceId = resolvedSourceId(link, options)
  const availability = resourceAvailability(link, options)
  const form = link.kind === 'workspace-file'
    ? (cachedFileMode(sourceId, link.fileId!) === 'copy' ? 'relative' : 'absolute')
    : link.form
  anchor.dataset.localLink = link.kind
  anchor.dataset.linkForm = form
  anchor.dataset.linkAvail = availability
  if (sourceId) anchor.dataset.linkSource = sourceId
  const source = sourceById(options?.sources, sourceId)
  if (source) anchor.dataset.linkSourceName = sourceChipLabel(source)
  if (isCrossSourceLink(sourceId, options?.pageSourceId)) {
    anchor.dataset.linkCross = '1'
    anchor.classList.add('file-link-cross-source')
  }
  if (link.kind === 'workspace-file' && link.fileId) {
    const mode = cachedFileMode(sourceId, link.fileId)
    const kind = cachedFileKind(sourceId, link.fileId)
    if (mode === 'copy' || mode === 'link') anchor.dataset.fileMode = mode
    if (kind === 'directory') anchor.dataset.fileKind = 'directory'
  }
  return true
}

export async function openLocalLink(
  href: string,
  options?: LinkContext & { workspaceRoot?: string | null },
) {
  const link = classifyLocalLink(href)
  if (!link) throw new Error('不是可打开的本地链接')

  if (!('__TAURI_INTERNALS__' in window)) {
    if (link.kind === 'absolute') {
      window.open(href, '_blank', 'noopener,noreferrer')
      return link
    }
    throw new Error('仅桌面端可打开工作区本地链接')
  }

  if (link.kind === 'workspace-file') {
    const source = sourceById(options?.sources, resolvedSourceId(link, options))
    if (!source) {
      throw new Error('当前链接所属存储源不是本地或 SMB，无法在本机打开登记文件。')
    }
    await openRegisteredFile(source, link.fileId!)
    return link
  }

  if (link.kind === 'absolute') {
    await getPlatformAccess().openNative(link.absolutePath!)
    return link
  }

  const root = resolveFileRoot(link, options)
  if (!root) {
    const source = sourceById(options?.sources, resolvedSourceId(link, options))
    if (source) {
      const store = blobStoreFor(source)
      if (store.openRelative) {
        await store.openRelative(source, link.relativePath!)
        return link
      }
    }
    throw new Error('当前链接所属存储源不是本地或 SMB，无法打开相对路径。')
  }
  const full = resolveRelativeToWorkspace(root, link.relativePath!)
  await getPlatformAccess().openNative(full)
  return link
}

export function isLocalLinkHref(href: string) {
  return Boolean(classifyLocalLink(href))
}

export async function convertFileProtocolHref(
  href: string,
  context: LinkContext & { ingestExternal?: boolean },
): Promise<string> {
  const abs = fileUrlToLocalPath(href)
  if (!abs) throw new Error(`无法解析路径：${href}`)
  const sources = context.sources ?? []
  // Prefer relative path if the file sits inside any local/SMB source root.
  for (const source of sources) {
    const root = fileRootForSource(source)
    if (!root) continue
    const relative = relativePathIfInsideRoot(root, abs)
    if (relative) return buildPathUrl(relative, source.id)
  }
  if (context.ingestExternal === false) {
    throw new Error('区外路径留给 Agent 收尾，启动迁移不 ingest')
  }
  const pageSource = sourceById(sources, context.pageSourceId)
  if (!pageSource) {
    throw new Error('当前页面未绑定存储源，无法把区外路径改写成工作区链接')
  }
  if (!fileRootForSource(pageSource) && !blobStoreFor(pageSource).canRegister) {
    throw new Error('当前页面未绑定本地或 SMB 存储源，无法把区外路径改写成工作区链接')
  }
  if (!blobStoreFor(pageSource).canRegister) {
    throw new Error('当前存储源不能登记区外路径')
  }
  const resource = await ingestRegisteredFile(pageSource, abs, 'link')
  return buildFileUrl(resource.id, pageSource.id)
}

export async function rewriteFileProtocolText(
  text: string,
  context: LinkContext & { ingestExternal?: boolean },
): Promise<{ text: string; converted: number; skipped: string[] }> {
  const skipped: string[] = []
  const replacements = new Map<string, string>()
  let converted = 0
  for (const href of collectFileProtocolHrefs(text)) {
    try {
      replacements.set(href, await convertFileProtocolHref(href, context))
      converted += 1
    } catch {
      skipped.push(href)
    }
  }
  return {
    text: replaceFileProtocolHrefs(text, (href) => replacements.get(href) ?? href),
    converted,
    skipped,
  }
}

/** Unified page href migration: sourceId backfill + file:/// → tie://path|file. */
export async function migratePageLocalHrefs<T extends { markdown: string; storageSourceId?: string | null }>(
  page: T,
  sources: StorageSource[],
  options?: { ingestExternal?: boolean },
): Promise<{ page: T; converted: number; skipped: string[] }> {
  const withSources = migratePageWorkspaceHrefs(page)
  if (!/file:\/\//i.test(withSources.markdown)) {
    return { page: withSources, converted: 0, skipped: [] }
  }
  const result = await rewriteFileProtocolText(withSources.markdown, {
    pageSourceId: withSources.storageSourceId,
    sources,
    ingestExternal: options?.ingestExternal,
  })
  return {
    page: { ...withSources, markdown: result.text },
    converted: result.converted,
    skipped: result.skipped,
  }
}
