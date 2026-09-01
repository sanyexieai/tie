import type { Page, PageId, StorageSource } from '@/types'
import { normalizePageSources, pageBoundToSource } from '@/services/page-sources'
import { mergeSyncPages } from '@/services/storage/sync-merge'
import type { LoadPagesResult, StorageAdapter, StorageCapabilities, SyncSourceContext } from '@/services/storage/types'

const fallbackKey = 'tie-demo-workspace-v1'
const historyKey = 'tie-demo-page-history-v1'

interface LocalPageRevision {
  id: string
  page: Page
}

const capabilities: StorageCapabilities = {
  load: true,
  save: true,
  delete: true,
  transfer: true,
  revisions: true,
  import: false,
  remote: false,
  manageConnection: false,
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function localSnapshot() {
  const raw = localStorage.getItem(fallbackKey)
  if (!raw) return { workspace: { sources: [] as StorageSource[] }, pages: [] as Page[] }
  return JSON.parse(raw) as { workspace: { sources: StorageSource[] }, pages: Page[] }
}

function saveLocalSnapshot(snapshot: { workspace: { sources: StorageSource[] }, pages: Page[] }) {
  localStorage.setItem(fallbackKey, JSON.stringify(snapshot))
}

function localHistory(): Record<PageId, LocalPageRevision[]> {
  try {
    const raw = localStorage.getItem(historyKey)
    return raw ? JSON.parse(raw) as Record<PageId, LocalPageRevision[]> : {}
  } catch {
    return {}
  }
}

function saveLocalHistory(history: Record<PageId, LocalPageRevision[]>) {
  localStorage.setItem(historyKey, JSON.stringify(history))
}

function pageHasChanged(before: Page, after: Page) {
  return before.title !== after.title
    || before.icon !== after.icon
    || before.parentId !== after.parentId
    || before.sortKey !== after.sortKey
    || before.markdown !== after.markdown
    || before.tags.join('\u0000') !== after.tags.join('\u0000')
    || before.deletedAt !== after.deletedAt
    || before.storageSourceId !== after.storageSourceId
}

function archiveLocalRevision(page: Page) {
  const history = localHistory()
  const revisions = history[page.id] ?? []
  history[page.id] = [{ id: id('rev'), page }, ...revisions].slice(0, 80)
  saveLocalHistory(history)
}

export const browserStorageAdapter: StorageAdapter = {
  kind: 'browser',
  capabilities,
  matches(sourceId) {
    return sourceId === 'source-demo-local'
  },
  listSources() {
    const snapshot = localSnapshot()
    return snapshot.workspace.sources ?? []
  },
  async loadPages(sourceId) {
    const snapshot = localSnapshot()
    return { pages: snapshot.pages.filter((page) => pageBoundToSource(page, sourceId)) }
  },
  async savePage(page) {
    const normalized = normalizePageSources(page)
    const snapshot = localSnapshot()
    const index = snapshot.pages.findIndex((candidate) => candidate.id === normalized.id)
    if (index === -1) snapshot.pages.push(normalized)
    else {
      const existing = snapshot.pages[index]
      if (pageHasChanged(existing, normalized)) archiveLocalRevision(existing)
      snapshot.pages[index] = normalized
    }
    saveLocalSnapshot(snapshot)
    return normalized
  },
  async permanentlyDeletePages(_sourceId, pages) {
    const pageIds = new Set(pages.map((page) => page.id))
    const snapshot = localSnapshot()
    // 浏览器演示：解绑时若仍绑定其他源则只更新绑定列表
    snapshot.pages = snapshot.pages.flatMap((page) => {
      if (!pageIds.has(page.id)) return [page]
      if (page.storageSourceId === _sourceId || (page.storageSourceIds ?? []).includes(_sourceId)) {
        const ids = [...new Set([page.storageSourceId, ...(page.storageSourceIds ?? [])])].filter((id) => id !== _sourceId)
        if (!ids.length) return []
        return [normalizePageSources({ ...page, storageSourceId: ids[0]!, storageSourceIds: ids })]
      }
      return []
    })
    saveLocalSnapshot(snapshot)
    const history = localHistory()
    snapshot.pages.forEach((page) => { if (pageIds.has(page.id)) return })
    pageIds.forEach((pageId) => {
      if (!snapshot.pages.some((page) => page.id === pageId)) delete history[pageId]
    })
    saveLocalHistory(history)
  },
  async transferPage(page, targetSourceId) {
    return this.savePage(normalizePageSources({ ...page, storageSourceId: targetSourceId, storageSourceIds: [targetSourceId] }))
  },
  async listPageRevisions(page) {
    return (localHistory()[page.id] ?? []).map((revision) => ({
      id: revision.id,
      savedAt: revision.page.updatedAt,
      title: revision.page.title,
    }))
  },
  async readPageRevision(page, revisionId) {
    const revision = localHistory()[page.id]?.find((candidate) => candidate.id === revisionId)
    if (!revision) throw new Error('未找到该历史版本')
    return revision.page
  },
  async renameSource(sourceId, name) {
    const snapshot = localSnapshot()
    const source = snapshot.workspace.sources.find((item) => item.id === sourceId)
    if (!source) throw new Error('存储源不存在')
    source.name = name.trim()
    saveLocalSnapshot(snapshot)
  },
  async syncSource(sourceId, context?: SyncSourceContext) {
    const loaded = await this.loadPages(sourceId)
    const remoteIds = new Set(loaded.pages.map((page) => page.id))
    return mergeSyncPages(sourceId, context?.localPages ?? [], loaded.pages, remoteIds)
  },
  async readLatestPage(page) {
    const loaded = await this.loadPages(page.storageSourceId)
    return loaded.pages.find((item) => item.id === page.id) ?? null
  },
}

export function loadBrowserSnapshot(): LoadPagesResult {
  const snapshot = localSnapshot()
  return { pages: snapshot.pages }
}
