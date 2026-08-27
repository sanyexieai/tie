import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { workspaceService } from '@/services/workspace'
import type { Page, PageId, PageTreeNode, Workspace } from '@/types'

export const useWorkspaceStore = defineStore('workspace', () => {
  const workspace = ref<Workspace | null>(null)
  const pages = ref<Page[]>([])
  const activePageId = ref<PageId | null>(null)
  const saving = ref(false)
  const initialized = ref(false)

  const activePage = computed(() => pages.value.find((page) => page.id === activePageId.value) ?? null)
  const tree = computed<PageTreeNode[]>(() => {
    const children = new Map<PageId | null, Page[]>()
    pages.value.forEach((page) => {
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
    activePageId.value = snapshot.pages[0]?.id ?? null
    initialized.value = true
  }

  async function createPage(parentId: PageId | null) {
    const page = await workspaceService.createPage(parentId)
    pages.value.push(page)
    activePageId.value = page.id
    return page
  }

  async function persist(page: Page) {
    saving.value = true
    try {
      const saved = await workspaceService.savePage({ ...page, updatedAt: new Date().toISOString() })
      const index = pages.value.findIndex((item) => item.id === saved.id)
      if (index === -1) pages.value.push(saved)
      else pages.value[index] = saved
    } finally { saving.value = false }
  }

  async function removePage(pageId: PageId) {
    await workspaceService.deletePage(pageId)
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
    const remaining = pages.value.filter((page) => !removed.has(page.id))
    pages.value = remaining
    activePageId.value = remaining[0]?.id ?? null
  }

  return { workspace, pages, activePageId, activePage, saving, initialized, tree, initialize, createPage, persist, removePage }
})
