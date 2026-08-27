import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { workspaceService } from '@/services/workspace'
import type { Page, PageId, PageLink, PageTreeNode, SearchResult, Workspace } from '@/types'

export const useWorkspaceStore = defineStore('workspace', () => {
  const workspace = ref<Workspace | null>(null)
  const pages = ref<Page[]>([])
  const activePageId = ref<PageId | null>(null)
  const showingTrash = ref(false)
  const showingSearch = ref(false)
  const searchQuery = ref('')
  const saving = ref(false)
  const initialized = ref(false)

  const activePage = computed(() => pages.value.find((page) => page.id === activePageId.value && !page.deletedAt) ?? null)
  const trashedPages = computed(() => pages.value.filter((page) => page.deletedAt).sort((a, b) => b.deletedAt!.localeCompare(a.deletedAt!)))
  const links = computed<PageLink[]>(() => {
    const linkPattern = /\]\(tie:\/\/page\/([A-Za-z0-9_-]+)\)/g
    return pages.value.filter((page) => !page.deletedAt).flatMap((page) => {
      const matches = [...page.markdown.matchAll(linkPattern)]
      return matches.map((match) => ({ fromPageId: page.id, toPageId: match[1] }))
    })
  })
  const searchResults = computed<SearchResult[]>(() => {
    const query = searchQuery.value.trim().toLocaleLowerCase()
    if (!query) return []
    return pages.value
      .filter((page) => !page.deletedAt)
      .map((page) => {
        const title = page.title.toLocaleLowerCase()
        const tagText = page.tags.join(' ').toLocaleLowerCase()
        const body = page.markdown.replace(/^# .*\n?/, '').toLocaleLowerCase()
        const titleScore = title === query ? 120 : title.startsWith(query) ? 90 : title.includes(query) ? 70 : 0
        const tagScore = tagText.includes(query) ? 45 : 0
        const bodyPosition = body.indexOf(query)
        const bodyScore = bodyPosition >= 0 ? Math.max(10, 35 - Math.min(bodyPosition, 25)) : 0
        const source = page.markdown.replace(/^# .*\n?/, '').replace(/[#>*_~`|()[\]]/g, ' ').replace(/\s+/g, ' ').trim()
        const originalPosition = source.toLocaleLowerCase().indexOf(query)
        const snippet = originalPosition >= 0 ? `${originalPosition > 42 ? '…' : ''}${source.slice(Math.max(0, originalPosition - 42), originalPosition + query.length + 72)}${source.length > originalPosition + query.length + 72 ? '…' : ''}` : source.slice(0, 114)
        return { page, score: titleScore + tagScore + bodyScore, snippet }
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.page.updatedAt.localeCompare(a.page.updatedAt))
  })
  const tree = computed<PageTreeNode[]>(() => {
    const children = new Map<PageId | null, Page[]>()
    pages.value.filter((page) => !page.deletedAt).forEach((page) => {
      const list = children.get(page.parentId) ?? []
      list.push(page)
      children.set(page.parentId, list)
    })
    const build = (parentId: PageId | null): PageTreeNode[] => (children.get(parentId) ?? [])
      .sort((a, b) => a.sortKey - b.sortKey || a.title.localeCompare(b.title, 'zh-CN'))
      .map((page) => ({ ...page, children: build(page.id) }))
    return build(null)
  })

  async function initialize() {
    const snapshot = await workspaceService.load()
    workspace.value = snapshot.workspace
    pages.value = snapshot.pages
    activePageId.value = snapshot.pages.find((page) => !page.deletedAt)?.id ?? null
    initialized.value = true
  }

  async function createPage(parentId: PageId | null) {
    const page = await workspaceService.createPage(parentId)
    pages.value.push(page)
    activePageId.value = page.id
    showingTrash.value = false
    showingSearch.value = false
    return page
  }

  function markdownLink(title: string, pageId: PageId) {
    return `[${title.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')}](tie://page/${pageId})`
  }

  function pageLinkPattern(pageId: PageId) {
    const escapedId = pageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`\\[[^\\]]*\\]\\(tie:\\/\\/page\\/${escapedId}\\)`, 'g')
  }

  function removePageLink(markdown: string, pageId: PageId) {
    const escapedId = pageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const standaloneLink = new RegExp(`^[\\t ]*\\[[^\\]]*\\]\\(tie:\\/\\/page\\/${escapedId}\\)[\\t ]*\\n?`, 'gm')
    return markdown.replace(standaloneLink, '')
  }

  function withChildPageLinks(page: Page) {
    const children = pages.value
      .filter((child) => child.parentId === page.id && !child.deletedAt)
      .sort((a, b) => a.sortKey - b.sortKey)
    const withoutChildLinks = children.reduce((content, child) => removePageLink(content, child.id), page.markdown).trimEnd()
    return children.length ? `${withoutChildLinks}\n\n${children.map((child) => markdownLink(child.title, child.id)).join('\n')}\n` : `${withoutChildLinks}\n`
  }

  async function syncChildPageLinks(parentId: PageId) {
    const parent = pages.value.find((page) => page.id === parentId && !page.deletedAt)
    if (!parent) return
    const markdown = withChildPageLinks(parent)
    if (markdown === parent.markdown) return
    const saved = await workspaceService.savePage({ ...parent, markdown, updatedAt: new Date().toISOString() })
    pages.value = pages.value.map((page) => page.id === saved.id ? saved : page)
  }

  async function createChildPage(parentId: PageId) {
    const parent = pages.value.find((page) => page.id === parentId)
    const child = await workspaceService.createPage(parentId)
    pages.value.push(child)
    if (parent) await syncChildPageLinks(parent.id)
    activePageId.value = child.id
    showingTrash.value = false
    return child
  }

  async function persist(page: Page) {
    saving.value = true
    try {
      const previous = pages.value.find((item) => item.id === page.id)
      const saved = await workspaceService.savePage({ ...page, markdown: withChildPageLinks(page), updatedAt: new Date().toISOString() })
      const index = pages.value.findIndex((item) => item.id === saved.id)
      if (index === -1) pages.value.push(saved)
      else pages.value[index] = saved
      if (previous && previous.title !== saved.title) {
        const linkPattern = pageLinkPattern(saved.id)
        const targetUrl = `tie://page/${saved.id}`
        const updates = pages.value.filter((item) => item.id !== saved.id && !item.deletedAt && item.markdown.includes(targetUrl)).map((item) => ({ ...item, markdown: item.markdown.replace(linkPattern, markdownLink(saved.title, saved.id)), updatedAt: new Date().toISOString() }))
        if (updates.length) {
          const savedLinks = await Promise.all(updates.map((item) => workspaceService.savePage(item)))
          pages.value = pages.value.map((item) => savedLinks.find((candidate) => candidate.id === item.id) ?? item)
        }
      }
    } finally { saving.value = false }
  }

  function collectSubtree(pageId: PageId) {
    const removed = new Set<PageId>([pageId])
    let changed = true
    while (changed) {
      changed = false
      pages.value.forEach((page) => {
        if (page.parentId && removed.has(page.parentId) && !removed.has(page.id)) {
          removed.add(page.id)
          changed = true
        }
      })
    }
    return removed
  }

  async function trashPage(pageId: PageId) {
    const removed = collectSubtree(pageId)
    const deletedAt = new Date().toISOString()
    saving.value = true
    try {
      const updated = await Promise.all(pages.value.filter((page) => removed.has(page.id)).map((page) => workspaceService.savePage({ ...page, deletedAt, updatedAt: deletedAt })))
      pages.value = pages.value.map((page) => updated.find((candidate) => candidate.id === page.id) ?? page)
      const parentUpdates = pages.value
        .filter((parent) => !parent.deletedAt)
        .map((parent) => {
          const deletedChildren = pages.value.filter((child) => removed.has(child.id) && child.parentId === parent.id)
          if (!deletedChildren.length) return null
          const markdown = deletedChildren.reduce((content, child) => removePageLink(content, child.id), parent.markdown)
          return markdown === parent.markdown ? null : { ...parent, markdown, updatedAt: deletedAt }
        })
        .filter((page): page is Page => Boolean(page))
      if (parentUpdates.length) {
        const savedParents = await Promise.all(parentUpdates.map((page) => workspaceService.savePage(page)))
        pages.value = pages.value.map((page) => savedParents.find((candidate) => candidate.id === page.id) ?? page)
      }
      if (removed.has(activePageId.value ?? '')) activePageId.value = pages.value.find((page) => !page.deletedAt)?.id ?? null
    } finally { saving.value = false }
  }

  async function restorePage(pageId: PageId) {
    const restored = collectSubtree(pageId)
    let parentId = pages.value.find((page) => page.id === pageId)?.parentId ?? null
    while (parentId) {
      const parent = pages.value.find((page) => page.id === parentId)
      if (!parent) break
      if (parent.deletedAt) restored.add(parent.id)
      parentId = parent.parentId
    }
    const updatedAt = new Date().toISOString()
    saving.value = true
    try {
      const updated = await Promise.all(pages.value.filter((page) => restored.has(page.id)).map((page) => workspaceService.savePage({ ...page, deletedAt: null, updatedAt })))
      pages.value = pages.value.map((page) => updated.find((candidate) => candidate.id === page.id) ?? page)
      const parentUpdates = pages.value
        .filter((parent) => !parent.deletedAt)
        .map((parent) => {
          const restoredChildren = pages.value.filter((child) => restored.has(child.id) && child.parentId === parent.id && !child.deletedAt)
          const missingLinks = restoredChildren.filter((child) => !parent.markdown.includes(`tie://page/${child.id}`))
          if (!missingLinks.length) return null
          return { ...parent, markdown: `${parent.markdown.trimEnd()}\n\n${missingLinks.map((child) => markdownLink(child.title, child.id)).join('\n')}\n`, updatedAt }
        })
        .filter((page): page is Page => Boolean(page))
      if (parentUpdates.length) {
        const savedParents = await Promise.all(parentUpdates.map((page) => workspaceService.savePage(page)))
        pages.value = pages.value.map((page) => savedParents.find((candidate) => candidate.id === page.id) ?? page)
      }
      activePageId.value = pageId
      showingTrash.value = false
    } finally { saving.value = false }
  }

  function canMovePage(pageId: PageId, parentId: PageId | null) {
    if (pageId === parentId) return false
    let current = parentId
    while (current) {
      const parent = pages.value.find((page) => page.id === current)
      if (!parent || parent.parentId === pageId) return parent?.parentId !== pageId
      current = parent.parentId
    }
    return true
  }

  async function movePage(pageId: PageId, parentId: PageId | null) {
    const page = pages.value.find((item) => item.id === pageId)
    if (!page || page.parentId === parentId || !canMovePage(pageId, parentId)) return false
    const previousParentId = page.parentId
    const nextSortKey = pages.value.filter((item) => item.parentId === parentId && item.id !== pageId).length
    await persist({ ...page, parentId, sortKey: nextSortKey })
    saving.value = true
    try {
      if (previousParentId && previousParentId !== parentId) await syncChildPageLinks(previousParentId)
      if (parentId) await syncChildPageLinks(parentId)
    } finally { saving.value = false }
    return true
  }

  async function reorderPage(pageId: PageId, targetId: PageId, position: 'before' | 'after') {
    const page = pages.value.find((item) => item.id === pageId)
    const target = pages.value.find((item) => item.id === targetId)
    if (!page || !target || page.id === target.id) return false
    const nextParentId = target.parentId
    if (!canMovePage(pageId, nextParentId)) return false
    const siblings = pages.value
      .filter((item) => item.parentId === nextParentId && item.id !== pageId && !item.deletedAt)
      .sort((a, b) => a.sortKey - b.sortKey)
    const targetIndex = siblings.findIndex((item) => item.id === targetId)
    if (targetIndex === -1) return false
    siblings.splice(targetIndex + (position === 'after' ? 1 : 0), 0, { ...page, parentId: nextParentId })
    const updatedPages = siblings.map((item, index) => ({ ...item, sortKey: index, parentId: nextParentId, updatedAt: new Date().toISOString() }))
    const previousParentId = page.parentId
    saving.value = true
    try {
      const saved = await Promise.all(updatedPages.filter((item) => {
        const original = pages.value.find((page) => page.id === item.id)
        return !original || original.sortKey !== item.sortKey || original.parentId !== item.parentId
      }).map((item) => workspaceService.savePage(item)))
      pages.value = pages.value.map((item) => saved.find((candidate) => candidate.id === item.id) ?? item)
      if (previousParentId && previousParentId !== nextParentId) await syncChildPageLinks(previousParentId)
      if (nextParentId) await syncChildPageLinks(nextParentId)
    } finally { saving.value = false }
    return true
  }

  function openPage(pageId: PageId) { activePageId.value = pageId; showingTrash.value = false; showingSearch.value = false }
  function openTrash() { showingTrash.value = true; showingSearch.value = false }
  function openSearch() { showingSearch.value = true; showingTrash.value = false }
  function pageById(pageId: PageId) { return pages.value.find((page) => page.id === pageId) ?? null }
  function outgoingLinks(pageId: PageId) { return links.value.filter((link) => link.fromPageId === pageId).map((link) => pageById(link.toPageId)).filter((page): page is Page => Boolean(page && !page.deletedAt)) }
  function backlinks(pageId: PageId) { return links.value.filter((link) => link.toPageId === pageId).map((link) => pageById(link.fromPageId)).filter((page): page is Page => Boolean(page && !page.deletedAt)) }

  return { workspace, pages, activePageId, activePage, saving, initialized, tree, trashedPages, showingTrash, showingSearch, searchQuery, searchResults, links, initialize, createPage, createChildPage, persist, trashPage, restorePage, movePage, reorderPage, openPage, openTrash, openSearch, outgoingLinks, backlinks }
})
