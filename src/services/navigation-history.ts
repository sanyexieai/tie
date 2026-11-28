interface PageNavigationOptions {
  current: () => string | null
  available: (pageId: string) => boolean
  open: (pageId: string) => boolean | Promise<boolean>
}

export function createPageNavigationHistory(options: PageNavigationOptions) {
  let pages: string[] = []
  let cursor = -1
  let revision = 0
  let target: string | null = null

  function record(pageId: string | null) {
    if (!pageId || pageId === target || pages[cursor] === pageId) return
    pages = [...pages.slice(0, cursor + 1), pageId]
    cursor = pages.length - 1
  }

  function reset(pageId: string | null = null) {
    revision += 1
    pages = pageId ? [pageId] : []
    cursor = pages.length - 1
  }

  async function move(direction: -1 | 1) {
    if (target) return false
    let index = cursor + direction
    while (index >= 0 && index < pages.length && !options.available(pages[index]!)) index += direction
    const pageId = pages[index]
    if (!pageId) return false
    const startedAt = revision
    target = pageId
    try {
      if (!await options.open(pageId) || startedAt !== revision || options.current() !== pageId) return false
      cursor = index
      return true
    } catch {
      return false
    } finally {
      target = null
    }
  }

  return { record, reset, move }
}
