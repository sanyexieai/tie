import type { Page } from '@/types'

/** 页面绑定的全部存储源（含主源），去重且主源优先。 */
export function pageSourceIds(page: Pick<Page, 'storageSourceId' | 'storageSourceIds'>): string[] {
  const ids = [page.storageSourceId, ...(page.storageSourceIds ?? [])]
    .map((id) => id.trim())
    .filter(Boolean)
  return [...new Set(ids)]
}

export function normalizePageSources(page: Page): Page {
  const ids = pageSourceIds(page)
  const primary = ids.includes(page.storageSourceId) && page.storageSourceId
    ? page.storageSourceId
    : (ids[0] ?? page.storageSourceId)
  return {
    ...page,
    storageSourceId: primary,
    storageSourceIds: primary ? (ids.length ? ids : [primary]) : ids,
  }
}

export function withPageSources(page: Page, primaryId: string, sourceIds: string[]): Page {
  return normalizePageSources({
    ...page,
    storageSourceId: primaryId,
    storageSourceIds: sourceIds,
  })
}

export function pageBoundToSource(page: Pick<Page, 'storageSourceId' | 'storageSourceIds'>, sourceId: string) {
  return pageSourceIds(page).includes(sourceId)
}

/** 比较页面正文是否一致（不含 updatedAt / 元数据漂移）。 */
export function pageContentEqual(
  a: Pick<Page, 'title' | 'markdown' | 'tags'>,
  b: Pick<Page, 'title' | 'markdown' | 'tags'>,
) {
  return a.title === b.title
    && a.markdown === b.markdown
    && a.tags.length === b.tags.length
    && a.tags.every((tag, index) => tag === b.tags[index])
}

/** 页面树与编辑器顶栏用的单字标签；完整名称放 title。 */
export function sourceShortLabel(name: string) {
  const first = Array.from(name.trim())[0]
  return first || '?'
}

/** 同 id 页面合并：内容取较新者，绑定源取并集。 */
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
    const primary = ids.includes(newer.storageSourceId) ? newer.storageSourceId : ids[0]!
    map.set(page.id, normalizePageSources({
      ...newer,
      storageSourceId: primary,
      storageSourceIds: ids,
    }))
  }
  return [...map.values()]
}
