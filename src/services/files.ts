import { invoke } from '@tauri-apps/api/core'
import { openPath } from '@tauri-apps/plugin-opener'

export const FILE_URL_PREFIX = 'tie://file/'

export type WorkspaceFileMode = 'copy' | 'link'

export interface WorkspaceFileResource {
  id: string
  title: string
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

export function buildFileUrl(fileId: string) {
  return `${FILE_URL_PREFIX}${fileId}`
}

export function parseFileUrl(href: string) {
  if (!href.startsWith(FILE_URL_PREFIX)) return null
  const fileId = href.slice(FILE_URL_PREFIX.length).split(/[?#]/)[0]?.trim()
  if (!fileId || !/^[A-Za-z0-9_-]+$/.test(fileId)) return null
  return { fileId }
}

export function collectFileIdsFromMarkdown(markdown: string) {
  const ids = new Set<string>()
  const pattern = /\]\(tie:\/\/file\/([A-Za-z0-9_-]+)\)/g
  for (const match of markdown.matchAll(pattern)) {
    if (match[1]) ids.add(match[1])
  }
  return [...ids]
}

export function fileLinkClass(mode: string | null | undefined) {
  if (mode === 'copy') return 'file-link file-link-copy'
  if (mode === 'link') return 'file-link file-link-link'
  return 'file-link'
}

export function fileLinkLabel(mode: string | null | undefined) {
  if (mode === 'copy') return '副本'
  if (mode === 'link') return '外链'
  return '文件'
}

const cacheByRoot = new Map<string, Map<string, WorkspaceFileResource>>()

export async function listWorkspaceFiles(root: string): Promise<WorkspaceFileResource[]> {
  if (!('__TAURI_INTERNALS__' in window)) return []
  const trimmed = root.trim()
  if (!trimmed) return []
  const list = await invoke<WorkspaceFileResource[]>('list_workspace_files', { root: trimmed })
  const map = new Map(list.map((item) => [item.id, item]))
  cacheByRoot.set(trimmed, map)
  return list
}

export async function resolveWorkspaceFile(root: string, fileId: string): Promise<WorkspaceFileResource | null> {
  if (!('__TAURI_INTERNALS__' in window)) return null
  const trimmed = root.trim()
  if (!trimmed || !fileId) return null
  const cached = cacheByRoot.get(trimmed)?.get(fileId)
  if (cached) return cached
  try {
    const item = await invoke<WorkspaceFileResource>('resolve_workspace_file', { root: trimmed, fileId })
    const map = cacheByRoot.get(trimmed) ?? new Map()
    map.set(fileId, item)
    cacheByRoot.set(trimmed, map)
    return item
  } catch {
    return null
  }
}

export function cachedFileMode(root: string | null | undefined, fileId: string) {
  if (!root) return null
  return cacheByRoot.get(root)?.get(fileId)?.mode ?? null
}

export async function openWorkspaceFile(root: string, fileId: string) {
  const resource = await resolveWorkspaceFile(root, fileId)
  if (!resource) throw new Error(`文件资源不存在：${fileId}`)
  if (!resource.exists) {
    throw new Error(
      resource.mode === 'link'
        ? `外链失效：${resource.openPath || resource.sourcePath}`
        : `副本缺失：${resource.openPath || resource.storedPath}`,
    )
  }
  await openPath(resource.openPath)
  return resource
}
