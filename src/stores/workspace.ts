import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { backendWorkspaceSource, backendS3ProviderSource, isBackendRemoteSourceId } from '@/services/backend'
import { mergePageSourceIds, mergePagesById, normalizePageSources, pageBoundToSource, pageContentEqual, pageSourceIds, pageWriteEqual, prunePageSources, remapPageSourceIds, withPageSources } from '@/services/page-sources'
import { reconcileSaveAgainstRemote } from '@/services/save-reconcile'
import { isLocalWinningConflict } from '@/services/storage/sync-merge'
import { loadLocalS3Providers, refreshS3Providers, s3StorageSource, takeS3SourceIdRemap, buildS3SourceIdHealingRemap } from '@/services/s3'
import { isCloudStorageSourceId } from '@/services/storage-identity'
import { dedupeStorageSources, isWorkspaceFileSource, uniqueSourceIds } from '@/services/storage-sources'
import { sourceStatusStore, syncQueue, storageRegistry } from '@/services/storage'
import { transferPreservesHistory } from '@/services/transfer-policy'
import { isMobileSupportedStorageKind, isMobileSupportedStorageSource, usesMobileUi } from '@/services/platform'
import { workspaceService } from '@/services/workspace'
import { useBackendStore } from '@/stores/backend'
import type { SyncConflict, SyncResult } from '@/services/storage/types'
import {
  connectSkill,
  disconnectSkill,
  listSkillConnections,
  type SkillConnection,
} from '@/services/codex-mcp'
import type { Page, PageId, PageLink, PageRevision, PageTreeNode, SearchResult, StorageKind, StorageSource, TagSummary, Workspace } from '@/types'

function sortSourcesByOrder(sources: StorageSource[], order: string[]) {
  const index = new Map(order.map((id, position) => [id, position]))
  return [...sources].sort((a, b) => {
    const left = index.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const right = index.get(b.id) ?? Number.MAX_SAFE_INTEGER
    return left - right || a.name.localeCompare(b.name, 'zh-CN')
  })
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const backend = useBackendStore()
  const workspace = ref<Workspace | null>(null)
  const pages = ref<Page[]>([])
  const activePageId = ref<PageId | null>(null)
  const storageSourceOrder = ref<string[]>([])
  const showingTrash = ref(false)
  const showingSearch = ref(false)
  const showingTags = ref(false)
  const showingGraph = ref(false)
  const showingRecent = ref(false)
  const showingFavorites = ref(false)
  const showingSkills = ref(false)
  const showingSkillManager = ref(false)
  const activeSkillId = ref<string | null>(null)
  const skillConnections = ref<SkillConnection[]>([])
  const skillsLoading = ref(false)
  const showingCommandPalette = ref(false)
  const selectedTag = ref<string | null>(null)
  const tagStorageSourceId = ref<string | null>(null)
  const searchQuery = ref('')
  const searchStorageSourceId = ref<string | null>(null)
  const commandQuery = ref('')
  const outlineScrollTarget = ref<number | null>(null)
  const outlineScrollRequest = ref(0)
  const saving = ref(false)
  const reloading = ref(false)
  const initialized = ref(false)
  const favoritePageIds = ref<PageId[]>([])
  const recentPageIds = ref<PageId[]>([])
  const collapsedPageIds = ref<PageId[]>([])
  const spellcheckEnabled = ref(true)
  const sourceMode = ref(false)
  const skillsSectionCollapsed = ref(true)
  const s3ProvidersVersion = ref(0)
  const syncQueueVersion = ref(0)
  const syncConflicts = ref<Map<PageId, SyncConflict & { sourceId: string }>>(new Map())
  const syncConflictsCount = computed(() => syncConflicts.value.size)
  const syncConflictPages = computed(() => [...syncConflicts.value.entries()]
    .map(([pageId, conflict]) => {
      const page = pages.value.find((item) => item.id === pageId)
      const source = allSources.value.find((item) => item.id === conflict.sourceId)
      return page && !page.deletedAt ? { pageId, conflict, page, source } : null
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item)))

  const rawSources = computed(() => dedupeStorageSources([
    ...(workspace.value?.sources ?? []).filter(isWorkspaceFileSource),
    ...(backend.connected ? backend.workspaces.map((item) => backendWorkspaceSource(item, backend.profile.endpoint)) : []),
    ...(backend.connected ? backend.providers.filter((provider) => provider.kind === 's3').map((provider) => backendS3ProviderSource(provider, backend.providerAvailability[provider.id] !== false)) : []),
    ...(s3ProvidersVersion.value >= 0 ? loadLocalS3Providers().map(s3StorageSource) : []),
  ]))

  if (typeof window !== 'undefined') {
    window.addEventListener('tie:s3-providers-changed', () => { s3ProvidersVersion.value += 1 })
    window.addEventListener('tie:sync-queue-changed', () => { syncQueueVersion.value += 1 })
  }
  const allSources = computed(() => sortSourcesByOrder(rawSources.value, storageSourceOrder.value))
  const pendingSyncCount = computed(() => syncQueueVersion.value >= 0 ? syncQueue.count() : 0)
  function pageHasPendingRemoteSave(pageId: PageId | null | undefined) {
    void syncQueueVersion.value
    if (!pageId) return false
    return syncQueue.list().some((item) => item.operation === 'save' && item.page.id === pageId)
  }
  function sourceRuntimeStatus(sourceId: string) {
    void syncQueueVersion.value
    return sourceStatusStore.get(sourceId)
  }
  const defaultStorageSourceId = computed(() => {
    const candidates = usesMobileUi.value
      ? allSources.value.filter((source) => isMobileSupportedStorageSource(source))
      : allSources.value
    const available = candidates.filter((source) => source.available !== false)
    const pool = available.length ? available : candidates
    return pool.find((source) => isCloudStorageSourceId(source.id))?.id
      ?? pool[0]?.id
      ?? null
  })
  const activeStorageSourceId = defaultStorageSourceId
  const activeSkill = computed(() => skillConnections.value.find((item) => item.id === activeSkillId.value) ?? null)
  const skillsWorkspaceSource = computed(() => {
    const preferred = defaultStorageSourceId.value
      ? allSources.value.find((source) => source.id === defaultStorageSourceId.value)
      : null
    if (preferred && (preferred.kind === 'local' || preferred.kind === 'smb') && preferred.available !== false && preferred.path) {
      return preferred
    }
    return allSources.value.find((source) => (
      (source.kind === 'local' || source.kind === 'smb')
      && source.available !== false
      && Boolean(source.path)
    )) ?? null
  })

  const activePage = computed(() => pages.value.find((page) => page.id === activePageId.value && !page.deletedAt) ?? null)
  const trashedPages = computed(() => pages.value
    .filter((page) => page.deletedAt)
    .sort((a, b) => b.deletedAt!.localeCompare(a.deletedAt!)))
  const favoritePages = computed(() => favoritePageIds.value.map((id) => pages.value.find((page) => page.id === id && !page.deletedAt)).filter((page): page is Page => Boolean(page)))
  const recentPages = computed(() => recentPageIds.value.map((id) => pages.value.find((page) => page.id === id && !page.deletedAt)).filter((page): page is Page => Boolean(page)))
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
      .filter((page) => !page.deletedAt && (!searchStorageSourceId.value || pageBoundToSource(page, searchStorageSourceId.value)))
      .map((page) => {
        const title = page.title.toLocaleLowerCase()
        const tagText = page.tags.join(' ').toLocaleLowerCase()
        const body = page.markdown.replace(/^# .*\n?/, '').toLocaleLowerCase()
        const titleScore = title === query ? 120 : title.startsWith(query) ? 90 : title.includes(query) ? 70 : 0
        const tagScore = tagText.includes(query) ? 45 : 0
        const bodyPosition = body.indexOf(query)
        const bodyScore = bodyPosition >= 0 ? Math.max(10, 35 - Math.min(bodyPosition, 25)) : 0
        const previewText = page.markdown.replace(/^# .*\n?/, '').replace(/[#>*_~`|()[\]]/g, ' ').replace(/\s+/g, ' ').trim()
        const originalPosition = previewText.toLocaleLowerCase().indexOf(query)
        const snippet = originalPosition >= 0 ? `${originalPosition > 42 ? '…' : ''}${previewText.slice(Math.max(0, originalPosition - 42), originalPosition + query.length + 72)}${previewText.length > originalPosition + query.length + 72 ? '…' : ''}` : previewText.slice(0, 114)
        const source = allSources.value.find((item) => item.id === page.storageSourceId)
        return { page, score: titleScore + tagScore + bodyScore, snippet, sourceName: source?.name ?? '未知来源', sourceKind: source?.kind ?? 'local' }
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.page.updatedAt.localeCompare(a.page.updatedAt))
  })
  const tagIndex = computed<TagSummary[]>(() => {
    const counts = new Map<string, number>()
    pages.value.filter((page) => !page.deletedAt && (!tagStorageSourceId.value || pageBoundToSource(page, tagStorageSourceId.value))).forEach((page) => page.tags.forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1)))
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
  })
  const taggedPages = computed(() => selectedTag.value ? pages.value.filter((page) => !page.deletedAt && (!tagStorageSourceId.value || pageBoundToSource(page, tagStorageSourceId.value)) && page.tags.includes(selectedTag.value!)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : [])
  const tree = computed<PageTreeNode[]>(() => {
    const scopedPages = mergePagesById(pages.value.filter((page) => !page.deletedAt))
    const children = new Map<PageId | null, Page[]>()
    scopedPages.forEach((page) => {
      let parentId = page.parentId
      if (parentId) {
        const parent = scopedPages.find((item) => item.id === parentId)
        // 多源绑定后父子可能主源不同，只要父页仍在工作区就保留层级
        if (!parent) parentId = null
      }
      const list = children.get(parentId) ?? []
      list.push({ ...page, parentId })
      children.set(parentId, list)
    })
    const build = (parentId: PageId | null): PageTreeNode[] => (children.get(parentId) ?? [])
      .sort((a, b) => a.sortKey - b.sortKey || a.title.localeCompare(b.title, 'zh-CN'))
      .map((page) => ({ ...page, children: build(page.id) }))
    return build(null)
  })

  function syncStorageSourceOrder(sources: StorageSource[] = rawSources.value) {
    const ids = new Set(sources.map((source) => source.id))
    const next = uniqueSourceIds(storageSourceOrder.value.filter((id) => ids.has(id)))
    sources.forEach((source) => {
      if (!next.includes(source.id)) next.push(source.id)
    })
    storageSourceOrder.value = next
  }

  /** 设置页可见的源顺序（移动端会过滤不支持的 kind）。 */
  function visibleStorageSourceOrder() {
    const byId = new Map(rawSources.value.map((source) => [source.id, source]))
    return storageSourceOrder.value.filter((id) => {
      const source = byId.get(id)
      if (!source) return false
      if (usesMobileUi.value && !isMobileSupportedStorageSource(source)) return false
      return true
    })
  }

  function canMoveStorageSource(sourceId: string, direction: -1 | 1) {
    syncStorageSourceOrder()
    const order = visibleStorageSourceOrder()
    const index = order.indexOf(sourceId)
    if (index === -1) return false
    const target = index + direction
    return target >= 0 && target < order.length
  }

  function moveStorageSource(sourceId: string, direction: -1 | 1) {
    syncStorageSourceOrder()
    const visible = visibleStorageSourceOrder()
    const index = visible.indexOf(sourceId)
    if (index === -1) return false
    const swapWith = visible[index + direction]
    if (!swapWith) return false
    const next = [...storageSourceOrder.value]
    const from = next.indexOf(sourceId)
    const to = next.indexOf(swapWith)
    if (from === -1 || to === -1) return false
    ;[next[from], next[to]] = [next[to], next[from]]
    storageSourceOrder.value = next
    persistPreferences()
    return true
  }

  function reorderStorageSource(sourceId: string, targetId: string, position: 'before' | 'after') {
    syncStorageSourceOrder()
    if (sourceId === targetId) return false
    const order = [...storageSourceOrder.value]
    const from = order.indexOf(sourceId)
    const targetIndex = order.indexOf(targetId)
    if (from === -1 || targetIndex === -1) return false
    order.splice(from, 1)
    const insertAt = order.indexOf(targetId)
    order.splice(position === 'after' ? insertAt + 1 : insertAt, 0, sourceId)
    storageSourceOrder.value = uniqueSourceIds(order)
    persistPreferences()
    return true
  }

  watch(() => rawSources.value.map((source) => source.id).join('\n'), () => {
    const previous = storageSourceOrder.value.join('\n')
    syncStorageSourceOrder()
    if (storageSourceOrder.value.join('\n') !== previous) persistPreferences()
    // 源列表就绪或变更后清掉异机/已删源留下的幽灵绑定。
    const known = knownStorageSourceIds()
    if (!known.size || !pages.value.length) return
    const next = pages.value.map((page) => prunePageSources(page, known))
    if (next.some((page, index) => pageSourceIds(page).join('\0') !== pageSourceIds(pages.value[index]!).join('\0'))) {
      pages.value = next
    }
  })

  function knownStorageSourceIds() {
    return new Set(allSources.value.map((source) => source.id))
  }

  function setPages(next: Page[]) {
    const known = knownStorageSourceIds()
    pages.value = mergePagesById(next).map((page) => prunePageSources(page, known))
  }

  async function initialize() {
    try {
      await refreshS3Providers({ migrateLegacy: true })
      const s3Remap = new Map([
        ...buildS3SourceIdHealingRemap([]),
        ...takeS3SourceIdRemap(),
      ])
      const snapshot = await workspaceService.loadLocal()
      // loadLocal 已做过 healing；这里再合并一次 take 的瞬时 remap，避免竞态漏映射。
      const healed = s3Remap.size
        ? snapshot.pages.map((page) => remapPageSourceIds(page, s3Remap))
        : snapshot.pages
      workspace.value = snapshot.workspace
      setPages(healed)
      const preferences = workspaceService.loadPreferences(snapshot.workspace.id)
      favoritePageIds.value = preferences.favoritePageIds
      recentPageIds.value = preferences.recentPageIds
      collapsedPageIds.value = preferences.collapsedPageIds
      spellcheckEnabled.value = preferences.spellcheckEnabled
      sourceMode.value = preferences.sourceMode
      skillsSectionCollapsed.value = preferences.skillsSectionCollapsed
      storageSourceOrder.value = preferences.storageSourceOrder.map((id) => s3Remap.get(id) ?? id)
      activePageId.value = preferences.recentPageIds
        .map((pageId) => healed.find((page) => page.id === pageId && !page.deletedAt)?.id)
        .find((pageId): pageId is PageId => Boolean(pageId))
        ?? healed.find((page) => !page.deletedAt)?.id
        ?? null
      syncStorageSourceOrder()
      if (s3Remap.size) persistPreferences()
      if (activePageId.value) expandPageAncestors(activePageId.value)
    } catch (error) {
      console.error('工作区初始化失败', error)
    } finally {
      initialized.value = true
    }
    void bootstrapRemoteSync()
  }

  function applySyncResults(results: SyncResult[]) {
    const next = new Map(syncConflicts.value)
    for (const result of results) {
      for (const [pageId, conflict] of next) {
        if (conflict.sourceId === result.sourceId && !result.conflicts.some((item) => item.pageId === pageId)) {
          next.delete(pageId)
        }
      }
      for (const conflict of result.conflicts) {
        next.set(conflict.pageId, { ...conflict, sourceId: result.sourceId })
      }
    }
    syncConflicts.value = next
  }

  function clearSyncConflict(pageId: PageId | null | undefined) {
    if (!pageId || !syncConflicts.value.has(pageId)) return
    const next = new Map(syncConflicts.value)
    next.delete(pageId)
    syncConflicts.value = next
  }

  async function bootstrapRemoteSync() {
    try {
      const flushed = await workspaceService.flushSyncQueue()
      if (flushed.length) {
        setPages([...pages.value.filter((item) => !flushed.some((page) => page.id === item.id)), ...flushed])
      }
      const { snapshot, syncResults } = await workspaceService.loadWithSync(pages.value)
      workspace.value = snapshot.workspace
      setPages([...snapshot.pages, ...pages.value])
      applySyncResults(syncResults)
      syncStorageSourceOrder()
    } catch (error) {
      console.warn('远程存储源同步失败', error)
    }
  }

  async function applyWorkspaceReload() {
    const beforeById = new Map(pages.value.map((page) => [page.id, page]))
    const { snapshot, syncResults } = await workspaceService.loadWithSync(pages.value)
    workspace.value = snapshot.workspace
    const conflictById = new Map(
      syncResults.flatMap((result) => result.conflicts.map((item) => [item.pageId, item] as const)),
    )
    const incoming = snapshot.pages.map((page) => {
      const local = beforeById.get(page.id)
      const conflict = conflictById.get(page.id)
      // 仅本地更新领先时保留本地；远程更新必须写入内存，否则多客户端无法收敛。
      if (local && conflict && isLocalWinningConflict(conflict)) return local
      if (local) {
        const known = knownStorageSourceIds()
        return prunePageSources({
          ...page,
          storageSourceId: local.storageSourceId || page.storageSourceId,
          storageSourceIds: mergePageSourceIds(local, page, { knownSourceIds: known }),
        }, known)
      }
      return page
    })
    const incomingIds = new Set(incoming.map((page) => page.id))
    // 快照未带回的本机页（同步缺口、仅内存）不能静默丢掉。
    const retained = [...beforeById.values()].filter((page) => !incomingIds.has(page.id))
    setPages([...incoming, ...retained])
    applySyncResults(syncResults)
    const availablePageIds = new Set(pages.value.filter((page) => !page.deletedAt).map((page) => page.id))
    favoritePageIds.value = favoritePageIds.value.filter((pageId) => availablePageIds.has(pageId))
    recentPageIds.value = recentPageIds.value.filter((pageId) => availablePageIds.has(pageId))
    collapsedPageIds.value = collapsedPageIds.value.filter((pageId) => availablePageIds.has(pageId))
    if (!activePageId.value || !availablePageIds.has(activePageId.value)) {
      activePageId.value = pages.value.find((page) => !page.deletedAt)?.id ?? null
    }
    syncStorageSourceOrder()
    persistPreferences()
    return true
  }

  async function reloadWorkspace() {
    if (reloading.value) return false
    reloading.value = true
    try {
      return await applyWorkspaceReload()
    } finally { reloading.value = false }
  }

  async function syncBackendSources() {
    if (!backend.connected) throw new Error('请先连接自定义后台')
    const connected = await backend.sync()
    if (!connected) throw new Error(backend.error || '后台同步失败')
    return reloadWorkspace()
  }

  async function syncSource(sourceId: string) {
    const result = await workspaceService.syncSource(sourceId, pages.value)
    const known = knownStorageSourceIds()
    known.add(sourceId)
    const remoteById = new Map(result.pages.map((page) => [page.id, normalizePageSources(page)]))
    const conflictById = new Map(result.conflicts.map((item) => [item.pageId, item]))
    const untouched = pages.value.filter((page) => !pageBoundToSource(page, sourceId))
    const reconciled = pages.value.filter((page) => pageBoundToSource(page, sourceId)).flatMap((page) => {
      const remote = remoteById.get(page.id)
      if (remote) {
        remoteById.delete(page.id)
        const conflict = conflictById.get(page.id)
        if (conflict && isLocalWinningConflict(conflict)) return [page]
        return mergePagesById([page, prunePageSources({
          ...remote,
          storageSourceId: page.storageSourceId || remote.storageSourceId,
          storageSourceIds: mergePageSourceIds(page, remote, { knownSourceIds: known, syncSourceId: sourceId }),
        }, known)])
      }
      const remaining = pageSourceIds(page).filter((id) => id !== sourceId)
      if (!remaining.length) {
        // 远端索引暂时没有时不要丢掉本机唯一副本（未上云 / 索引滞后）。
        return [page]
      }
      return [withPageSources(page, page.storageSourceId === sourceId ? remaining[0]! : page.storageSourceId, remaining)]
    })
    pages.value = mergePagesById([
      ...untouched,
      ...reconciled,
      ...[...remoteById.values()].map((page) => prunePageSources({
        ...page,
        storageSourceId: known.has(page.storageSourceId) ? page.storageSourceId : sourceId,
        storageSourceIds: mergePageSourceIds(
          { storageSourceId: sourceId, storageSourceIds: [sourceId] },
          page,
          { knownSourceIds: known, syncSourceId: sourceId },
        ),
      }, known)),
    ]).map((page) => prunePageSources(page, knownStorageSourceIds()))
    applySyncResults([result])
    return result
  }

  async function syncRemoteSources() {
    if (reloading.value) return false
    reloading.value = true
    try {
      await workspaceService.flushSyncQueue()
      if (backend.connected) {
        const connected = await backend.sync()
        if (!connected) throw new Error(backend.error || '后台同步失败')
      }
      const ok = await applyWorkspaceReload()
      syncQueueVersion.value += 1
      return ok
    } finally {
      reloading.value = false
    }
  }

  async function flushOfflineQueue() {
    const flushed = await workspaceService.flushSyncQueue()
    setPages([...pages.value.filter((item) => !flushed.some((page) => page.id === item.id)), ...flushed])
    syncQueueVersion.value += 1
    return flushed.length
  }

  async function addStorageSource(kind: StorageKind = 'local') {
    if (usesMobileUi.value && kind === 'smb') {
      throw new Error('移动端不支持 SMB 挂载目录')
    }
    if (usesMobileUi.value && !isMobileSupportedStorageKind(kind)) {
      throw new Error('移动端仅支持本地目录、S3 与自定义后台')
    }
    const snapshot = await workspaceService.addStorageSource(kind)
    if (!snapshot) return false
    workspace.value = snapshot.workspace
    setPages(snapshot.pages)
    syncStorageSourceOrder()
    const preferences = workspaceService.loadPreferences(snapshot.workspace.id)
    favoritePageIds.value = preferences.favoritePageIds
    recentPageIds.value = preferences.recentPageIds
    collapsedPageIds.value = preferences.collapsedPageIds
    spellcheckEnabled.value = preferences.spellcheckEnabled
    sourceMode.value = preferences.sourceMode
    skillsSectionCollapsed.value = preferences.skillsSectionCollapsed
    persistPreferences()
    showingTrash.value = false
    showingSearch.value = false
    showingTags.value = false
    showingGraph.value = false
    showingRecent.value = false
    showingFavorites.value = false
    showingSkills.value = false
    return true
  }

  async function importMarkdownFiles() {
    const targetSourceId = defaultStorageSourceId.value
    if (!targetSourceId) return false
    const snapshot = await workspaceService.importMarkdownFiles(targetSourceId)
    if (!snapshot) return false
    workspace.value = snapshot.workspace
    setPages(snapshot.pages)
    return true
  }

  async function openFromFiles() {
    const result = await workspaceService.openMarkdownFiles()
    if (!result) return false
    workspace.value = result.snapshot.workspace
    setPages(result.snapshot.pages)
    syncStorageSourceOrder()
    persistPreferences()
    const pageId = result.openedPageIds.find((id) => result.snapshot.pages.some((page) => page.id === id && !page.deletedAt))
      ?? result.openedPageIds[0]
      ?? null
    if (pageId) openPage(pageId)
    return true
  }

  async function removeStorageSource(sourceId: string) {
    const snapshot = await workspaceService.removeStorageSource(sourceId)
    if (!snapshot) return false
    workspace.value = snapshot.workspace
    setPages(snapshot.pages.filter((page) => !pageBoundToSource(page, sourceId)))
    syncStorageSourceOrder()
    persistPreferences()
    return true
  }

  async function renameStorageSource(sourceId: string, name: string) {
    const cleanName = name.trim()
    if (!cleanName || cleanName.length > 80) return false
    const snapshot = await workspaceService.renameStorageSource(sourceId, cleanName)
    workspace.value = snapshot.workspace
    setPages(snapshot.pages)
    return true
  }

  async function renameWorkspace(name: string) {
    const cleanName = name.trim()
    if (!cleanName || cleanName.length > 80) return false
    const snapshot = await workspaceService.renameWorkspace(cleanName)
    workspace.value = snapshot.workspace
    setPages(snapshot.pages)
    return true
  }

  function persistPreferences() {
    if (!workspace.value) return
    workspaceService.savePreferences(workspace.value.id, {
      favoritePageIds: favoritePageIds.value,
      recentPageIds: recentPageIds.value,
      collapsedPageIds: collapsedPageIds.value,
      spellcheckEnabled: spellcheckEnabled.value,
      sourceMode: sourceMode.value,
      storageSourceOrder: storageSourceOrder.value,
      skillsSectionCollapsed: skillsSectionCollapsed.value,
    })
  }

  function markRecentlyOpened(pageId: PageId) {
    recentPageIds.value = [pageId, ...recentPageIds.value.filter((id) => id !== pageId)].slice(0, 15)
    persistPreferences()
  }

  function toggleFavorite(pageId: PageId) {
    favoritePageIds.value = favoritePageIds.value.includes(pageId)
      ? favoritePageIds.value.filter((id) => id !== pageId)
      : [pageId, ...favoritePageIds.value]
    persistPreferences()
  }

  function toggleSpellcheck() {
    spellcheckEnabled.value = !spellcheckEnabled.value
    persistPreferences()
  }

  function toggleSourceMode() {
    sourceMode.value = !sourceMode.value
    persistPreferences()
  }

  function toggleSkillsSectionCollapsed() {
    skillsSectionCollapsed.value = !skillsSectionCollapsed.value
    persistPreferences()
  }

  function togglePageCollapsed(pageId: PageId) {
    collapsedPageIds.value = collapsedPageIds.value.includes(pageId)
      ? collapsedPageIds.value.filter((id) => id !== pageId)
      : [...collapsedPageIds.value, pageId]
    persistPreferences()
  }

  function expandPage(pageId: PageId) {
    if (!collapsedPageIds.value.includes(pageId)) return
    collapsedPageIds.value = collapsedPageIds.value.filter((id) => id !== pageId)
    persistPreferences()
  }

  function expandPageAncestors(pageId: PageId) {
    const ancestors = new Set<PageId>()
    const seen = new Set<PageId>()
    let current = pages.value.find((page) => page.id === pageId && !page.deletedAt)
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id)
      ancestors.add(current.parentId)
      current = pages.value.find((page) => page.id === current!.parentId && !page.deletedAt)
    }
    const next = collapsedPageIds.value.filter((id) => !ancestors.has(id))
    if (next.length === collapsedPageIds.value.length) return
    collapsedPageIds.value = next
    persistPreferences()
  }

  async function createPage(parentId: PageId | null) {
    const parent = parentId ? pages.value.find((item) => item.id === parentId) : null
    const fallbackPage = pages.value.find((item) => {
      if (item.deletedAt) return false
      if (!usesMobileUi.value) return true
      const source = allSources.value.find((candidate) => candidate.id === item.storageSourceId)
      return source && isMobileSupportedStorageSource(source)
    })
    const parentCloud = parent ? pageSourceIds(parent).find((id) => isCloudStorageSourceId(id)) : null
    const storageSourceId = (parent && isCloudStorageSourceId(parent.storageSourceId) ? parent.storageSourceId : null)
      ?? parentCloud
      ?? defaultStorageSourceId.value
      ?? fallbackPage?.storageSourceId
    if (!storageSourceId) {
      throw new Error(usesMobileUi.value ? '请先添加本地目录、S3 或后台存储源' : '请先连接一个存储源')
    }
    const page = await workspaceService.createPage(parentId, storageSourceId)
    pages.value = mergePagesById([...pages.value, page])
    activePageId.value = page.id
    markRecentlyOpened(page.id)
    clearSpecialViews()
    return page
  }

  function markdownLink(title: string, pageId: PageId) {
    return `[${title.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')}](tie://page/${pageId})`
  }

  function markdownWithTitle(markdown: string, title: string) {
    if (/^# .+$/m.test(markdown)) return markdown.replace(/^# .*$/m, `# ${title}`)
    return `# ${title}\n\n${markdown}`
  }

  function pageLinkPattern(pageId: PageId) {
    const escapedId = pageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`\\[[^\\]]*\\]\\(tie:\\/\\/page\\/${escapedId}\\)`, 'g')
  }

  function unlinkPageMarkdownReference(markdown: string, pageId: PageId) {
    const escapedId = pageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const linkedPage = new RegExp(`\\[([^\\]]*)\\]\\(tie:\\/\\/page\\/${escapedId}\\)`, 'g')
    return markdown.replace(linkedPage, '$1')
  }

  async function createChildPage(parentId: PageId) {
    const parent = pages.value.find((page) => page.id === parentId)
    if (!parent) throw new Error('父页面不存在')
    const child = await workspaceService.createPage(parentId, parent.storageSourceId)
    pages.value.push(child)
    expandPage(parentId)
    activePageId.value = child.id
    markRecentlyOpened(child.id)
    showingTrash.value = false
    return child
  }

  async function createLinkedPage(title: string) {
    const storageSourceId = activePage.value?.storageSourceId ?? defaultStorageSourceId.value
    if (!storageSourceId) throw new Error('请先连接一个存储源')
    const created = await workspaceService.createPage(null, storageSourceId)
    const cleanTitle = title.trim() || '无标题'
    const saved = await workspaceService.savePage({ ...created, title: cleanTitle, markdown: `# ${cleanTitle}\n\n`, updatedAt: new Date().toISOString() })
    pages.value.push(saved)
    return saved
  }

  async function duplicatePage(pageId: PageId) {
    const original = pages.value.find((page) => page.id === pageId && !page.deletedAt)
    if (!original) return null
    const created = await workspaceService.createPage(original.parentId, original.storageSourceId)
    const title = `${original.title || '无标题'} 副本`
    const body = original.markdown.replace(/^# .*\n?/, '').trimStart()
    const saved = await workspaceService.savePage({
      ...created,
      title,
      markdown: `# ${title}\n\n${body}`,
      tags: [...original.tags],
      updatedAt: new Date().toISOString(),
    })
    pages.value.push(saved)
    await reorderPage(saved.id, original.id, 'after')
    activePageId.value = saved.id
    markRecentlyOpened(saved.id)
    return saved
  }

  async function renamePage(pageId: PageId, title: string) {
    const page = pages.value.find((item) => item.id === pageId && !item.deletedAt)
    const cleanTitle = title.trim()
    if (!page || !cleanTitle || cleanTitle === page.title) return false
    await persist({ ...page, title: cleanTitle, markdown: markdownWithTitle(page.markdown, cleanTitle) })
    return true
  }

  async function linkUnlinkedMention(sourcePageId: PageId, targetPageId: PageId) {
    const source = pages.value.find((page) => page.id === sourcePageId && !page.deletedAt)
    const target = pages.value.find((page) => page.id === targetPageId && !page.deletedAt)
    if (!source || !target || source.id === target.id) return false
    const escapedTitle = target.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!escapedTitle) return false
    const mentionPattern = new RegExp(escapedTitle)
    const protectedLinkPattern = /(\[[^\]]*\]\(tie:\/\/page\/[A-Za-z0-9_-]+\))/g
    const parts = source.markdown.split(protectedLinkPattern)
    let linked = false
    const markdown = parts.map((part, index) => {
      if (linked || index % 2 === 1) return part
      if (!mentionPattern.test(part)) return part
      linked = true
      return part.replace(mentionPattern, markdownLink(target.title, target.id))
    }).join('')
    if (!linked) return false
    await persist({ ...source, markdown })
    return true
  }

  async function unlinkPageReference(sourcePageId: PageId, targetPageId: PageId) {
    const source = pages.value.find((page) => page.id === sourcePageId && !page.deletedAt)
    const target = pages.value.find((page) => page.id === targetPageId && !page.deletedAt)
    if (!source || !target) return false
    const markdown = unlinkPageMarkdownReference(source.markdown, targetPageId)
    if (markdown === source.markdown) return false
    await persist({ ...source, markdown })
    return true
  }

  function registerSyncConflict(pageId: PageId, sourceId: string, localUpdatedAt: string, remoteUpdatedAt: string) {
    const next = new Map(syncConflicts.value)
    next.set(pageId, { pageId, localUpdatedAt, remoteUpdatedAt, sourceId })
    syncConflicts.value = next
  }

  function adoptRemotePage(remote: Page, previous: Page) {
    const known = knownStorageSourceIds()
    pages.value = pages.value.map((item) => (
      item.id === remote.id
        ? prunePageSources({
          ...remote,
          storageSourceIds: mergePageSourceIds(previous, remote, { knownSourceIds: known }),
          storageSourceId: previous.storageSourceId || remote.storageSourceId,
        }, known)
        : item
    ))
    clearSyncConflict(remote.id)
  }

  /** 同一页面的保存串行化，避免自动保存重叠时误用旧 expectedUpdatedAt。 */
  const persistChains = new Map<PageId, Promise<void>>()

  async function persist(page: Page, options?: { force?: boolean }) {
    const prior = persistChains.get(page.id) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const chained = prior.catch(() => undefined).then(() => gate)
    persistChains.set(page.id, chained)
    await prior.catch(() => undefined)
    saving.value = true
    try {
      await persistUnlocked(page, options)
    } finally {
      saving.value = false
      release()
      if (persistChains.get(page.id) === chained) persistChains.delete(page.id)
    }
  }

  async function persistUnlocked(page: Page, options?: { force?: boolean }) {
    const previous = pages.value.find((item) => item.id === page.id)
    // 树层级只认 frontmatter.parent_id；正文里的 tie://page 链接只做关联，不回写子页列表。
    const contentDraft = page
    // 无正文/标题/标签/删除态/树结构差异时不写盘、不刷新 updatedAt（避免自动保存空转）。
    if (!options?.force && previous && pageWriteEqual(contentDraft, previous)) {
      return
    }
    const draft = { ...contentDraft, updatedAt: new Date().toISOString() }
    let expectedUpdatedAt = options?.force ? undefined : previous?.updatedAt

    // 仅「本地领先」的同步冲突禁止静默覆盖；远程已采纳的冲突允许继续保存/对齐。
    if (!options?.force && syncConflicts.value.has(page.id)) {
      const conflict = syncConflicts.value.get(page.id)
      if (conflict && isLocalWinningConflict(conflict)) {
        throw new Error('页面已在其他设备更新，请重新载入后再保存')
      }
    }

    if (!options?.force && previous) {
      const latest = await workspaceService.readLatestPage(previous).catch(() => null)
      if (latest) {
        const result = reconcileSaveAgainstRemote(previous, draft, latest)
        if (result.action === 'skip') {
          adoptRemotePage(result.page, previous)
          return
        }
        if (result.action === 'conflict') {
          registerSyncConflict(page.id, previous.storageSourceId, draft.updatedAt, result.remote.updatedAt)
          throw new Error('页面已在其他设备更新，请重新载入后再保存')
        }
        expectedUpdatedAt = result.expectedUpdatedAt
        if (result.adoptRemoteTimestamp) {
          pages.value = pages.value.map((item) => (
            item.id === page.id ? { ...item, updatedAt: result.adoptRemoteTimestamp! } : item
          ))
        }
      }
    }

    try {
      const saved = await workspaceService.savePage(
        draft,
        { expectedUpdatedAt, force: options?.force },
      )
      const index = pages.value.findIndex((item) => item.id === saved.id)
      if (index === -1) pages.value.push(saved)
      else pages.value[index] = saved
      clearSyncConflict(saved.id)
      if (previous && previous.title !== saved.title) {
        const linkPattern = pageLinkPattern(saved.id)
        const targetUrl = `tie://page/${saved.id}`
        const updates = pages.value.filter((item) => item.id !== saved.id && !item.deletedAt && item.markdown.includes(targetUrl)).map((item) => ({ ...item, markdown: item.markdown.replace(linkPattern, markdownLink(saved.title, saved.id)), updatedAt: new Date().toISOString() }))
        if (updates.length) {
          const savedLinks = await Promise.all(updates.map((item) => workspaceService.savePage(item, { force: options?.force })))
          pages.value = pages.value.map((item) => savedLinks.find((candidate) => candidate.id === item.id) ?? item)
        }
      }
    } catch (error) {
      if (!options?.force && previous && error instanceof Error && error.message.includes('其他设备')) {
        const latest = await workspaceService.readLatestPage(previous).catch(() => null)
        if (latest && pageContentEqual(latest, draft)) {
          adoptRemotePage(latest, previous)
          clearSyncConflict(latest.id)
          return
        }
        if (latest) registerSyncConflict(page.id, previous.storageSourceId, draft.updatedAt, latest.updatedAt)
      }
      throw error
    }
  }

  async function resolveConflictOverwriteLocal(page: Page) {
    await persist(page, { force: true })
  }

  async function resolveConflictLoadRemote(pageId: PageId) {
    return refreshPage(pageId)
  }

  function canTransferPageTo(targetSourceId: string, fromSourceId = activePage.value?.storageSourceId) {
    if (!fromSourceId) return false
    return storageRegistry.canTransfer(fromSourceId, targetSourceId)
  }

  function canBindPageTo(targetSourceId: string, page = activePage.value) {
    if (!page) return false
    if (pageBoundToSource(page, targetSourceId)) return true
    return storageRegistry.canTransfer(page.storageSourceId, targetSourceId)
  }

  function transferHistoryNotice(fromSourceId: string, toSourceId: string) {
    if (transferPreservesHistory(fromSourceId, toSourceId)) {
      return '页面树、Markdown 文件、历史版本与图片附件会一并移动。'
    }
    if (isBackendRemoteSourceId(fromSourceId) || isBackendRemoteSourceId(toSourceId)) {
      return '页面正文与图片附件会迁移；历史版本可能不会完整保留。'
    }
    return '页面正文会迁移，但历史版本与部分附件可能不会完整保留。'
  }

  async function bindPageToSource(pageId: PageId, targetSourceId: string, includeChildren = false) {
    const page = pages.value.find((item) => item.id === pageId)
    if (!page) return false
    const pageIds = new Set<PageId>([page.id])
    if (includeChildren) {
      let changed = true
      while (changed) {
        changed = false
        pages.value.forEach((candidate) => {
          if (!candidate.deletedAt && candidate.parentId && pageIds.has(candidate.parentId) && !pageIds.has(candidate.id)) {
            pageIds.add(candidate.id)
            changed = true
          }
        })
      }
    }
    const targets = pages.value.filter((candidate) => pageIds.has(candidate.id) && !pageBoundToSource(candidate, targetSourceId))
    const updated: Page[] = []
    for (const candidate of targets) updated.push(await storageRegistry.bindPageToSource(candidate, targetSourceId))
    if (!updated.length && pageBoundToSource(page, targetSourceId)) return true
    pages.value = pages.value.map((item) => updated.find((candidate) => candidate.id === item.id) ?? item)
    return updated.length > 0
  }

  async function unbindPageFromSource(pageId: PageId, sourceId: string, includeChildren = false) {
    const page = pages.value.find((item) => item.id === pageId)
    if (!page || !pageBoundToSource(page, sourceId)) return false
    if (pageSourceIds(page).length <= 1) throw new Error('至少需要保留一个存储源')
    const pageIds = new Set<PageId>([page.id])
    if (includeChildren) {
      let changed = true
      while (changed) {
        changed = false
        pages.value.forEach((candidate) => {
          if (!candidate.deletedAt && candidate.parentId && pageIds.has(candidate.parentId) && !pageIds.has(candidate.id)) {
            pageIds.add(candidate.id)
            changed = true
          }
        })
      }
    }
    const updated: Page[] = []
    for (const candidate of pages.value.filter((item) => pageIds.has(item.id) && pageBoundToSource(item, sourceId))) {
      if (pageSourceIds(candidate).length <= 1) continue
      updated.push(await storageRegistry.unbindPageFromSource(candidate, sourceId))
    }
    pages.value = pages.value.map((item) => updated.find((candidate) => candidate.id === item.id) ?? item)
    return updated.length > 0
  }

  async function setPagePrimarySource(pageId: PageId, sourceId: string) {
    const page = pages.value.find((item) => item.id === pageId)
    if (!page) return false
    const updated = await storageRegistry.setPagePrimarySource(page, sourceId)
    pages.value = pages.value.map((item) => (item.id === updated.id ? updated : item))
    return true
  }

  async function pushPageToMirrors(pageId: PageId) {
    const page = pages.value.find((item) => item.id === pageId)
    if (!page) return false
    await storageRegistry.pushPageToMirrors(page)
    return true
  }

  async function transferPage(pageId: PageId, targetSourceId: string, includeChildren = false) {
    const page = pages.value.find((item) => item.id === pageId)
    if (!page) return false
    const pageIds = new Set<PageId>([page.id])
    if (includeChildren) {
      let changed = true
      while (changed) {
        changed = false
        pages.value.forEach((candidate) => {
          if (!candidate.deletedAt && candidate.parentId && pageIds.has(candidate.parentId) && !pageIds.has(candidate.id)) {
            pageIds.add(candidate.id)
            changed = true
          }
        })
      }
    }
    const moving = pages.value.filter((candidate) => pageIds.has(candidate.id) && candidate.storageSourceId !== targetSourceId)
    if (!moving.length) return false
    const moved: Page[] = []
    for (const candidate of moving) moved.push(await workspaceService.transferPage(candidate, targetSourceId))
    pages.value = pages.value.map((item) => moved.find((candidate) => candidate.id === item.id) ?? item)
    return true
  }

  async function listPageRevisions(pageId: PageId): Promise<PageRevision[]> {
    const page = pages.value.find((item) => item.id === pageId)
    return page ? workspaceService.listPageRevisions(page) : []
  }

  async function readPageRevision(pageId: PageId, revisionId: string): Promise<Page | null> {
    const page = pages.value.find((item) => item.id === pageId)
    return page ? workspaceService.readPageRevision(page, revisionId) : null
  }

  async function restorePageRevision(pageId: PageId, revisionId: string) {
    const page = pages.value.find((item) => item.id === pageId)
    if (!page) return null
    const saved = await workspaceService.restorePageRevision(page, revisionId)
    pages.value = pages.value.map((item) => item.id === saved.id ? saved : item)
    return saved
  }

  async function exportPageMarkdown(pageId: PageId) {
    const page = pages.value.find((item) => item.id === pageId && !item.deletedAt)
    return page ? workspaceService.exportPageMarkdown(page) : false
  }

  async function readLatestPage(pageId: PageId) {
    const page = pages.value.find((item) => item.id === pageId)
    return page ? workspaceService.readLatestPage(page) : null
  }

  async function refreshPage(pageId: PageId) {
    const current = pages.value.find((item) => item.id === pageId)
    if (!current) throw new Error('页面不存在')
    let latest = await workspaceService.readLatestPage(current)
    if (!latest) {
      const result = await workspaceService.syncSource(current.storageSourceId, pages.value)
      applySyncResults([result])
      latest = result.pages.find((item) => item.id === pageId) ?? null
      if (latest) {
        await syncSource(current.storageSourceId)
        clearSyncConflict(pageId)
        return pages.value.find((item) => item.id === pageId) ?? latest
      }
    }
    if (!latest) throw new Error('无法从存储源读取该页面，请检查连接后重试')
    pages.value = pages.value.map((page) => (page.id === pageId
      ? prunePageSources({
        ...latest!,
        storageSourceId: current.storageSourceId || latest!.storageSourceId,
        storageSourceIds: mergePageSourceIds(current, latest!, { knownSourceIds: knownStorageSourceIds() }),
      }, knownStorageSourceIds())
      : page))
    clearSyncConflict(pageId)
    return latest
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
      // 树只认 parent_id：软删子树即可，不必改父页正文里的手动链接。
      const updated = await Promise.all(pages.value.filter((page) => removed.has(page.id)).map((page) => workspaceService.savePage({ ...page, deletedAt, updatedAt: deletedAt }, { force: true })))
      pages.value = pages.value.map((page) => updated.find((candidate) => candidate.id === page.id) ?? page)
      if (removed.has(activePageId.value ?? '')) activePageId.value = pages.value.find((page) => !page.deletedAt)?.id ?? null
    } finally { saving.value = false }
  }

  async function restorePage(pageId: PageId) {
    const restored = collectSubtree(pageId)
    const root = pages.value.find((page) => page.id === pageId)
    let parentId = root?.parentId ?? null
    let restoreAtTopLevel = false
    while (parentId) {
      const parent = pages.value.find((page) => page.id === parentId)
      if (!parent) {
        restoreAtTopLevel = true
        break
      }
      if (parent.deletedAt) restored.add(parent.id)
      parentId = parent.parentId
    }
    const updatedAt = new Date().toISOString()
    saving.value = true
    try {
      const updated = await Promise.all(pages.value.filter((page) => restored.has(page.id)).map((page) => workspaceService.savePage({ ...page, parentId: restoreAtTopLevel && page.id === pageId ? null : page.parentId, deletedAt: null, updatedAt }, { force: true })))
      pages.value = pages.value.map((page) => updated.find((candidate) => candidate.id === page.id) ?? page)
      activePageId.value = pageId
      showingTrash.value = false
    } finally { saving.value = false }
  }

  async function permanentlyDeletePage(pageId: PageId) {
    const root = pages.value.find((page) => page.id === pageId && page.deletedAt)
    if (!root) return false
    const removed = collectSubtree(pageId)
    const targets = pages.value.filter((page) => removed.has(page.id) && page.deletedAt)
    if (!targets.length) return false
    saving.value = true
    try {
      await workspaceService.permanentlyDeletePages(targets)
      pages.value = pages.value.filter((page) => !removed.has(page.id))
      await unlinkDeletedPageReferences(removed)
      favoritePageIds.value = favoritePageIds.value.filter((id) => !removed.has(id))
      recentPageIds.value = recentPageIds.value.filter((id) => !removed.has(id))
      persistPreferences()
      return true
    } finally { saving.value = false }
  }

  async function emptyTrash() {
    const targets = pages.value.filter((page) => page.deletedAt)
    if (!targets.length) return false
    saving.value = true
    try {
      const removed = new Set(targets.map((page) => page.id))
      await workspaceService.permanentlyDeletePages(targets)
      pages.value = pages.value.filter((page) => !removed.has(page.id))
      await unlinkDeletedPageReferences(removed)
      favoritePageIds.value = favoritePageIds.value.filter((id) => !removed.has(id))
      recentPageIds.value = recentPageIds.value.filter((id) => !removed.has(id))
      persistPreferences()
      return true
    } finally { saving.value = false }
  }

  async function unlinkDeletedPageReferences(removed: Set<PageId>) {
    const updatedPages = pages.value
      .filter((page) => !removed.has(page.id))
      .map((page) => {
        const markdown = [...removed].reduce((content, pageId) => unlinkPageMarkdownReference(content, pageId), page.markdown)
        return markdown === page.markdown ? null : { ...page, markdown, updatedAt: new Date().toISOString() }
      })
      .filter((page): page is Page => Boolean(page))
    if (!updatedPages.length) return
    const saved = await Promise.all(updatedPages.map((page) => workspaceService.savePage(page)))
    pages.value = pages.value.map((page) => saved.find((candidate) => candidate.id === page.id) ?? page)
  }

  async function renameTag(oldName: string, nextName: string, storageSourceId: string | null = tagStorageSourceId.value) {
    const cleanName = nextName.trim().replace(/^#\s*/, '')
    if (!cleanName || cleanName.length > 32 || cleanName.includes(',')) return false
    const normalizedOld = oldName.toLocaleLowerCase()
    const targets = pages.value.filter((page) => !page.deletedAt
      && (!storageSourceId || pageBoundToSource(page, storageSourceId))
      && page.tags.some((tag) => tag.toLocaleLowerCase() === normalizedOld))
    if (!targets.length) return false
    saving.value = true
    try {
      const updated = await Promise.all(targets.map((page) => {
        const tags = [...new Map(page.tags.map((tag) => [tag.toLocaleLowerCase() === normalizedOld ? cleanName.toLocaleLowerCase() : tag.toLocaleLowerCase(), tag.toLocaleLowerCase() === normalizedOld ? cleanName : tag])).values()]
        return workspaceService.savePage({ ...page, tags, updatedAt: new Date().toISOString() })
      }))
      pages.value = pages.value.map((page) => updated.find((candidate) => candidate.id === page.id) ?? page)
      if (selectedTag.value?.toLocaleLowerCase() === normalizedOld) selectedTag.value = cleanName
      return true
    } finally { saving.value = false }
  }

  async function deleteTag(name: string, storageSourceId: string | null = tagStorageSourceId.value) {
    const normalizedName = name.toLocaleLowerCase()
    const targets = pages.value.filter((page) => !page.deletedAt
      && (!storageSourceId || pageBoundToSource(page, storageSourceId))
      && page.tags.some((tag) => tag.toLocaleLowerCase() === normalizedName))
    if (!targets.length) return false
    saving.value = true
    try {
      const updated = await Promise.all(targets.map((page) => workspaceService.savePage({
        ...page,
        tags: page.tags.filter((tag) => tag.toLocaleLowerCase() !== normalizedName),
        updatedAt: new Date().toISOString(),
      })))
      pages.value = pages.value.map((page) => updated.find((candidate) => candidate.id === page.id) ?? page)
      if (selectedTag.value?.toLocaleLowerCase() === normalizedName) selectedTag.value = null
      return true
    } finally { saving.value = false }
  }

  function canMovePage(pageId: PageId, parentId: PageId | null) {
    if (pageId === parentId) return false
    const page = pages.value.find((item) => item.id === pageId)
    if (!page) return false
    if (parentId) {
      const parent = pages.value.find((item) => item.id === parentId)
      if (!parent) return false
    }
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
    const nextSortKey = pages.value.filter((item) => item.parentId === parentId && item.id !== pageId).length
    await persist({ ...page, parentId, sortKey: nextSortKey })
    if (parentId) expandPage(parentId)
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
    saving.value = true
    try {
      const saved = await Promise.all(updatedPages.filter((item) => {
        const original = pages.value.find((page) => page.id === item.id)
        return !original || original.sortKey !== item.sortKey || original.parentId !== item.parentId
      }).map((item) => workspaceService.savePage(item)))
      pages.value = pages.value.map((item) => saved.find((candidate) => candidate.id === item.id) ?? item)
      if (nextParentId) expandPage(nextParentId)
    } finally { saving.value = false }
    return true
  }

  function clearSpecialViews() {
    showingTrash.value = false
    showingSearch.value = false
    showingTags.value = false
    showingGraph.value = false
    showingRecent.value = false
    showingFavorites.value = false
    showingSkills.value = false
    showingSkillManager.value = false
  }

  function openMobileHome() {
    activePageId.value = null
    clearSpecialViews()
  }

  function openPage(pageId: PageId) {
    const switching = activePageId.value !== pageId
    activePageId.value = pageId
    expandPageAncestors(pageId)
    markRecentlyOpened(pageId)
    clearSpecialViews()
    // 仅在切入该页时拉一次最新版；不做窗口聚焦全量同步。
    if (switching) void refreshPageOnOpen(pageId)
  }

  /** 打开页面时安静刷新：正文实质相同则只消假冲突，有更新才写入内存。 */
  async function refreshPageOnOpen(pageId: PageId) {
    if (reloading.value || saving.value) return
    const current = pages.value.find((item) => item.id === pageId && !item.deletedAt)
    if (!current || !isCloudStorageSourceId(current.storageSourceId)) return
    try {
      const latest = await workspaceService.readLatestPage(current).catch(() => null)
      if (!latest) return
      if (pageContentEqual(latest, current)) {
        clearSyncConflict(pageId)
        if (latest.updatedAt !== current.updatedAt) {
          pages.value = pages.value.map((page) => (
            page.id === pageId ? { ...page, updatedAt: latest.updatedAt } : page
          ))
        }
        return
      }
      pages.value = pages.value.map((page) => (page.id === pageId
        ? prunePageSources({
          ...latest,
          storageSourceId: current.storageSourceId || latest.storageSourceId,
          storageSourceIds: mergePageSourceIds(current, latest, { knownSourceIds: knownStorageSourceIds() }),
        }, knownStorageSourceIds())
        : page))
      if (latest.updatedAt >= current.updatedAt) clearSyncConflict(pageId)
    } catch (error) {
      console.warn('打开页面时刷新失败', error)
    }
  }
  function openCommandPalette() { commandQuery.value = ''; showingCommandPalette.value = true }
  function closeCommandPalette() { showingCommandPalette.value = false }
  function scrollToOutlineHeading(index: number) { outlineScrollTarget.value = index; outlineScrollRequest.value += 1 }
  function openTrash() { clearSpecialViews(); showingTrash.value = true }
  function openSearch() { clearSpecialViews(); showingSearch.value = true }
  function openTags(tag: string | null = null) { selectedTag.value = tag; clearSpecialViews(); showingTags.value = true }
  function openGraph() { clearSpecialViews(); showingGraph.value = true }
  function openRecent() { clearSpecialViews(); showingRecent.value = true }
  function openFavorites() { clearSpecialViews(); showingFavorites.value = true }

  async function refreshSkills() {
    if (!('__TAURI_INTERNALS__' in window)) {
      skillConnections.value = []
      return skillConnections.value
    }
    skillsLoading.value = true
    try {
      skillConnections.value = await listSkillConnections()
      if (activeSkillId.value && !skillConnections.value.some((item) => item.id === activeSkillId.value)) {
        activeSkillId.value = skillConnections.value[0]?.id ?? null
      }
      return skillConnections.value
    } finally {
      skillsLoading.value = false
    }
  }

  async function openSkills(skillId: string | null = null) {
    clearSpecialViews()
    showingSkills.value = true
    showingSkillManager.value = false
    activeSkillId.value = skillId
    const connections = await refreshSkills()
    if (skillId) activeSkillId.value = skillId
    else if (!activeSkillId.value) activeSkillId.value = connections[0]?.id ?? null
  }

  async function openSkillManager() {
    clearSpecialViews()
    showingSkills.value = true
    showingSkillManager.value = true
    activeSkillId.value = null
    await refreshSkills()
  }

  function selectSkill(skillId: string) {
    activeSkillId.value = skillId
    showingSkills.value = true
    showingSkillManager.value = false
    showingTrash.value = false
    showingSearch.value = false
    showingTags.value = false
    showingGraph.value = false
    showingRecent.value = false
    showingFavorites.value = false
  }

  async function connectScannedSkill(skillPath: string) {
    const connection = await connectSkill(skillPath)
    await refreshSkills()
    selectSkill(connection.id)
    return connection
  }

  async function disconnectManagedSkill(connectionId: string) {
    skillConnections.value = await disconnectSkill(connectionId)
    if (activeSkillId.value === connectionId) {
      activeSkillId.value = skillConnections.value[0]?.id ?? null
      if (!activeSkillId.value) showingSkillManager.value = true
    }
    return skillConnections.value
  }

  function pageById(pageId: PageId) { return pages.value.find((page) => page.id === pageId) ?? null }
  function outgoingLinks(pageId: PageId) { return links.value.filter((link) => link.fromPageId === pageId).map((link) => pageById(link.toPageId)).filter((page): page is Page => Boolean(page && !page.deletedAt)) }
  function backlinks(pageId: PageId) { return links.value.filter((link) => link.toPageId === pageId).map((link) => pageById(link.fromPageId)).filter((page): page is Page => Boolean(page && !page.deletedAt)) }
  function unlinkedMentions(pageId: PageId) {
    const page = pageById(pageId)
    if (!page) return []
    const linkedPageIds = new Set(outgoingLinks(pageId).map((linked) => linked.id))
    const text = page.markdown
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
      .toLocaleLowerCase()
    return pages.value
      .filter((candidate) => !candidate.deletedAt && candidate.id !== pageId && !linkedPageIds.has(candidate.id))
      .filter((candidate) => {
        const title = candidate.title.trim()
        return title.length >= 2 && title !== '无标题' && text.includes(title.toLocaleLowerCase())
      })
      .sort((a, b) => b.title.length - a.title.length || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, 8)
  }

  return { workspace, allSources, pages, activePageId, activePage, defaultStorageSourceId, activeStorageSourceId, skillsWorkspaceSource, storageSourceOrder, pendingSyncCount, syncConflictsCount, syncConflictPages, sourceRuntimeStatus, syncConflicts, pageHasPendingRemoteSave, saving, reloading, initialized, tree, trashedPages, showingTrash, showingSearch, showingTags, showingGraph, showingRecent, showingFavorites, showingSkills, showingSkillManager, activeSkillId, activeSkill, skillConnections, skillsLoading, showingCommandPalette, selectedTag, tagStorageSourceId, tagIndex, taggedPages, searchQuery, searchStorageSourceId, commandQuery, outlineScrollTarget, outlineScrollRequest, searchResults, links, favoritePageIds, favoritePages, recentPageIds, recentPages, collapsedPageIds, spellcheckEnabled, sourceMode, skillsSectionCollapsed, initialize, reloadWorkspace, syncBackendSources, syncSource, syncRemoteSources, flushOfflineQueue, addStorageSource, importMarkdownFiles, openFromFiles, removeStorageSource, renameStorageSource, renameWorkspace, canMoveStorageSource, moveStorageSource, reorderStorageSource, scrollToOutlineHeading, createPage, createChildPage, createLinkedPage, duplicatePage, renamePage, linkUnlinkedMention, unlinkPageReference, persist, transferPage, canTransferPageTo, canBindPageTo, bindPageToSource, unbindPageFromSource, setPagePrimarySource, pushPageToMirrors, transferHistoryNotice, listPageRevisions, readPageRevision, restorePageRevision, exportPageMarkdown, readLatestPage, refreshPage, clearSyncConflict, adoptRemotePage, resolveConflictOverwriteLocal, resolveConflictLoadRemote, trashPage, restorePage, permanentlyDeletePage, emptyTrash, renameTag, deleteTag, movePage, reorderPage, toggleFavorite, toggleSpellcheck, toggleSourceMode, toggleSkillsSectionCollapsed, togglePageCollapsed, expandPage, expandPageAncestors, openPage, openMobileHome, openTrash, openSearch, openTags, openGraph, openRecent, openFavorites, openSkills, openSkillManager, selectSkill, refreshSkills, connectScannedSkill, disconnectManagedSkill, openCommandPalette, closeCommandPalette, outgoingLinks, backlinks, unlinkedMentions }
})
