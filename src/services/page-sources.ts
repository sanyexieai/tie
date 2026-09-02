import type { Page } from '@/types'
import { isCloudStorageSourceId, isLocalStorageSourceId } from '@/services/storage-identity'

/** 页面绑定的全部存储源（含主源），去重且主源优先。 */
export function pageSourceIds(page: Pick<Page, 'storageSourceId' | 'storageSourceIds'>): string[] {
  const ids = [page.storageSourceId, ...(page.storageSourceIds ?? [])]
    .map((id) => id.trim())
    .filter(Boolean)
  return [...new Set(ids)]
}

/** 仅云端绑定（跨端同步面）。 */
export function pageCloudSourceIds(page: Pick<Page, 'storageSourceId' | 'storageSourceIds'>): string[] {
  return pageSourceIds(page).filter((id) => isCloudStorageSourceId(id))
}

/** 仅本机绑定（不进云端 frontmatter）。 */
export function pageLocalSourceIds(page: Pick<Page, 'storageSourceId' | 'storageSourceIds'>): string[] {
  return pageSourceIds(page).filter((id) => isLocalStorageSourceId(id))
}

/** 备份镜像源（不含协作主源）。 */
export function pageMirrorSourceIds(page: Pick<Page, 'storageSourceId' | 'storageSourceIds'>): string[] {
  const primary = page.storageSourceId.trim()
  return pageSourceIds(page).filter((id) => id !== primary)
}

/** 协作主源候选：有云端绑定时只能是云端；纯本机页才允许本机 id。 */
export function resolveCollaborationPrimary(
  sourceIds: string[],
  preferred?: string | null,
): string {
  const ids = [...new Set(sourceIds.map((id) => id.trim()).filter(Boolean))]
  if (!ids.length) return preferred?.trim() || ''
  const cloud = ids.filter((id) => isCloudStorageSourceId(id))
  if (cloud.length) {
    if (preferred && cloud.includes(preferred)) return preferred
    return cloud[0]!
  }
  if (preferred && ids.includes(preferred)) return preferred
  return ids[0]!
}

export function normalizePageSources(page: Page): Page {
  const ids = pageSourceIds(page)
  const primary = resolveCollaborationPrimary(ids, page.storageSourceId)
  return {
    ...page,
    storageSourceId: primary,
    storageSourceIds: primary ? (ids.length ? ids : [primary]) : ids,
  }
}

/**
 * 丢掉当前工作区里不存在的绑定源（异机 local id、已删 S3 等）。
 * 同步会把远端 JSON 里的 storageSourceIds 并进来，容易留下点不开的幽灵芯片。
 */
export function prunePageSources(page: Page, knownSourceIds: Iterable<string>): Page {
  const known = knownSourceIds instanceof Set ? knownSourceIds : new Set([...knownSourceIds].map((id) => id.trim()).filter(Boolean))
  if (!known.size) return normalizePageSources(page)
  const kept = pageSourceIds(page).filter((id) => known.has(id))
  if (!kept.length) {
    const primary = page.storageSourceId.trim()
    return normalizePageSources({
      ...page,
      storageSourceId: primary,
      storageSourceIds: primary ? [primary] : [],
    })
  }
  return withPageSources(page, resolveCollaborationPrimary(kept, page.storageSourceId), kept)
}

/**
 * 合并远端绑定：
 * - 本机源只保留本地已有的（不吸入异机 local id）
 * - 云端源保留已知 + 当前同步源
 */
export function mergePageSourceIds(
  local: Pick<Page, 'storageSourceId' | 'storageSourceIds'>,
  remote: Pick<Page, 'storageSourceId' | 'storageSourceIds'>,
  options: { knownSourceIds: Iterable<string>; syncSourceId?: string },
): string[] {
  const known = new Set([...options.knownSourceIds].map((id) => id.trim()).filter(Boolean))
  const syncId = options.syncSourceId?.trim()
  if (syncId) known.add(syncId)

  const localIds = pageSourceIds(local)
  // 远端里的本机 id 一律丢弃（只认云端协作面）。
  const remoteCloudIds = pageSourceIds(remote).filter((id) => isCloudStorageSourceId(id))
  const merged = [...localIds, ...remoteCloudIds]
  if (syncId) merged.push(syncId)

  const kept = [...new Set(merged)].filter((id) => {
    if (isLocalStorageSourceId(id)) return known.has(id) && localIds.includes(id)
    return known.has(id)
  })
  return kept.length ? kept : localIds
}

/** 写入存储前的页面投影：写云端时剥离本机 sourceId，避免污染跨端元数据。 */
export function pageForStorageWrite(page: Page, writeSourceId: string): Page {
  const normalized = normalizePageSources(page)
  const writeId = writeSourceId.trim() || normalized.storageSourceId
  if (!isCloudStorageSourceId(writeId)) return normalized

  const cloudIds = [...new Set([...pageCloudSourceIds(normalized), writeId])]
  const primary = resolveCollaborationPrimary(cloudIds, normalized.storageSourceId)
  return withPageSources(normalized, primary, cloudIds)
}

export function remapPageSourceIds(page: Page, idMap: Map<string, string>): Page {
  if (!idMap.size) return normalizePageSources(page)
  const mapId = (id: string) => idMap.get(id) ?? id
  return withPageSources(
    page,
    mapId(page.storageSourceId),
    pageSourceIds(page).map(mapId),
  )
}

export function withPageSources(page: Page, primaryId: string, sourceIds: string[]): Page {
  const ids = [...new Set([primaryId, ...sourceIds].map((id) => id.trim()).filter(Boolean))]
  const primary = resolveCollaborationPrimary(ids, primaryId)
  return {
    ...page,
    storageSourceId: primary,
    storageSourceIds: primary ? ids : [],
  }
}

export function pageBoundToSource(page: Pick<Page, 'storageSourceId' | 'storageSourceIds'>, sourceId: string) {
  return pageSourceIds(page).includes(sourceId)
}

/** 比较用正文归一化：吃掉文末多余空行，避免 TipTap/存储差一行空白就报冲突。 */
export function normalizePageMarkdown(markdown: string) {
  const trimmed = markdown.replace(/[ \t]+$/gm, '').replace(/\s+$/u, '')
  return trimmed ? `${trimmed}\n` : '\n'
}

/** 比较页面正文是否一致（不含 updatedAt / 元数据漂移）。 */
export function pageContentEqual(
  a: Pick<Page, 'title' | 'markdown' | 'tags'>,
  b: Pick<Page, 'title' | 'markdown' | 'tags'>,
) {
  return a.title === b.title
    && normalizePageMarkdown(a.markdown) === normalizePageMarkdown(b.markdown)
    && a.tags.length === b.tags.length
    && a.tags.every((tag, index) => tag === b.tags[index])
}

/** 页面树与编辑器顶栏用的单字标签；完整名称放 title。 */
export function sourceShortLabel(name: string) {
  const first = Array.from(name.trim())[0]
  return first || '?'
}

/** 绑定列表角色文案：协作主源仅用于云端。 */
export function pageSourceRoleLabel(
  page: Pick<Page, 'storageSourceId' | 'storageSourceIds'>,
  sourceId: string,
): 'primary' | 'mirror' | 'unbound' {
  if (!pageBoundToSource(page, sourceId)) return 'unbound'
  if (isCloudStorageSourceId(sourceId) && sourceId === page.storageSourceId) return 'primary'
  return 'mirror'
}

/** 同 id 页面合并：内容取较新者，绑定源取并集；主源优先云端协作主源。 */
export function mergePagesById(pages: Page[]): Page[] {
  const map = new Map<string, Page>()
  for (const raw of pages) {
    const page = normalizePageSources(raw)
    const existing = map.get(page.id)
    if (!existing) {
      map.set(page.id, page)
      continue
    }
    const ids = [...new Set([...pageSourceIds(existing), ...pageSourceIds(page)])]
    const newer = existing.updatedAt >= page.updatedAt ? existing : page
    const preferred = isCloudStorageSourceId(existing.storageSourceId)
      ? existing.storageSourceId
      : (isCloudStorageSourceId(newer.storageSourceId) ? newer.storageSourceId : existing.storageSourceId)
    const primary = resolveCollaborationPrimary(ids, preferred)
    map.set(page.id, withPageSources(newer, primary, ids))
  }
  return [...map.values()]
}
