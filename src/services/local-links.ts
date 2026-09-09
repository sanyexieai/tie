import { openPath } from '@tauri-apps/plugin-opener'
import {
  cachedFileKind,
  cachedFileMode,
  FILE_URL_PREFIX,
  fileLinkClass as workspaceFileLinkClass,
  openWorkspaceFile,
  parseFileUrl,
} from '@/services/files'
import { fileUrlToLocalPath } from '@/services/local-path'

/** Workspace-relative path link: `tie://path/docs/spec.pdf` */
export const PATH_URL_PREFIX = 'tie://path/'

export type LocalLinkKind = 'workspace-file' | 'absolute' | 'relative'

export interface ClassifiedLocalLink {
  kind: LocalLinkKind
  href: string
  fileId?: string
  absolutePath?: string
  /** POSIX-style path relative to workspace root (no leading slash). */
  relativePath?: string
}

const LOCAL_LINK_CLASSES = [
  'file-link',
  'file-link-copy',
  'file-link-link',
  'file-link-directory',
  'file-link-absolute',
  'file-link-relative',
] as const

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

export function buildPathUrl(relativePath: string) {
  const normalized = normalizeRelativePath(relativePath)
  return `${PATH_URL_PREFIX}${normalized.split('/').map(encodeURIComponent).join('/')}`
}

export function parsePathUrl(href: string): { relativePath: string } | null {
  if (!href.startsWith(PATH_URL_PREFIX)) return null
  const raw = href.slice(PATH_URL_PREFIX.length).split(/[?#]/)[0] ?? ''
  if (!raw) return null
  try {
    const decoded = raw
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
    return { relativePath: normalizeRelativePath(decoded) }
  } catch {
    return null
  }
}

export function classifyLocalLink(href: string): ClassifiedLocalLink | null {
  const trimmed = String(href || '').trim()
  if (!trimmed) return null

  const file = parseFileUrl(trimmed)
  if (file) {
    return { kind: 'workspace-file', href: trimmed, fileId: file.fileId }
  }

  const relative = parsePathUrl(trimmed)
  if (relative) {
    return { kind: 'relative', href: trimmed, relativePath: relative.relativePath }
  }

  const absolutePath = fileUrlToLocalPath(trimmed)
  if (absolutePath) {
    return { kind: 'absolute', href: trimmed, absolutePath }
  }

  return null
}

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
  options?: { workspaceRoot?: string | null },
): string {
  if (link.kind === 'workspace-file' && link.fileId) {
    const mode = cachedFileMode(options?.workspaceRoot, link.fileId)
    const kind = cachedFileKind(options?.workspaceRoot, link.fileId)
    return workspaceFileLinkClass(mode, kind)
  }
  if (link.kind === 'absolute') return 'file-link file-link-absolute'
  if (link.kind === 'relative') return 'file-link file-link-relative'
  return 'file-link'
}

export function localLinkLabel(link: ClassifiedLocalLink): string {
  if (link.kind === 'absolute') return '绝对'
  if (link.kind === 'relative') return '相对'
  return '文件'
}

export function clearLocalLinkClasses(anchor: HTMLAnchorElement) {
  for (const token of LOCAL_LINK_CLASSES) {
    anchor.classList.remove(token)
  }
  delete anchor.dataset.fileMode
  delete anchor.dataset.fileKind
  delete anchor.dataset.localLink
}

export function applyLocalLinkClasses(
  anchor: HTMLAnchorElement,
  href: string,
  options?: { workspaceRoot?: string | null },
) {
  const link = classifyLocalLink(href)
  clearLocalLinkClasses(anchor)
  if (!link) return false
  for (const token of localLinkClass(link, options).split(/\s+/)) {
    if (token) anchor.classList.add(token)
  }
  anchor.dataset.localLink = link.kind
  if (link.kind === 'workspace-file' && link.fileId) {
    const mode = cachedFileMode(options?.workspaceRoot, link.fileId)
    const kind = cachedFileKind(options?.workspaceRoot, link.fileId)
    if (mode === 'copy' || mode === 'link') anchor.dataset.fileMode = mode
    if (kind === 'directory') anchor.dataset.fileKind = 'directory'
  }
  return true
}

export async function openLocalLink(
  href: string,
  options?: { workspaceRoot?: string | null },
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
    const root = options?.workspaceRoot?.trim()
    if (!root) throw new Error('当前页面没有可用的本地/SMB 工作区，无法打开文件资源。')
    await openWorkspaceFile(root, link.fileId!)
    return link
  }

  if (link.kind === 'absolute') {
    await openPath(link.absolutePath!)
    return link
  }

  const full = resolveRelativeToWorkspace(options?.workspaceRoot ?? '', link.relativePath!)
  await openPath(full)
  return link
}

export function isLocalLinkHref(href: string) {
  return Boolean(classifyLocalLink(href))
}

export { FILE_URL_PREFIX }
