import { mergePageSourceIds, mergePagesById, pageSourceIds, pageWriteEqual } from '@/services/page-sources'
import type { Page } from '@/types'

export function captureStartupPages(pages: Page[]): Page[] {
  return pages.map((page) => ({
    ...page,
    tags: [...page.tags],
    storageSourceIds: page.storageSourceIds ? [...page.storageSourceIds] : undefined,
  }))
}

export function pageChangedSinceStartup(now: Page, before: Page) {
  return !pageWriteEqual(now, before) || now.updatedAt !== before.updatedAt
    || now.storageSourceId !== before.storageSourceId || pageSourceIds(now).join('\0') !== pageSourceIds(before).join('\0')
}

export function mergeStartupPages(before: Page[], incoming: Page[], live: Page[]): Page[] {
  const initial = new Map(before.map((page) => [page.id, page]))
  const current = new Map(live.map((page) => [page.id, page]))
  return mergePagesById([...live, ...incoming])
    .filter((page) => !initial.has(page.id) || current.has(page.id))
    .map((page) => {
      const now = current.get(page.id)
      const old = initial.get(page.id)
      if (now && (!old || pageChangedSinceStartup(now, old))) {
        const sourcesChanged = !old || now.storageSourceId !== old.storageSourceId
          || pageSourceIds(now).join('\0') !== pageSourceIds(old).join('\0')
        return {
          ...page, ...now,
          storageSourceIds: sourcesChanged ? pageSourceIds(now)
            : mergePageSourceIds(now, page, { knownSourceIds: [...pageSourceIds(now), ...pageSourceIds(page)] }),
        }
      }
      return page
    })
}
