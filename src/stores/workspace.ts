import { computed, ref, watch } from 'vue'
import { acceptHMRUpdate, defineStore } from 'pinia'
import { backendService, isBackendRemoteSourceId, isBackendSourceId } from '@/services/backend'
import { mergePageSourceIds, mergePagesById, normalizePageSources, pageBoundToSource, pageContentEqual, pageSourceIds, pageWriteEqual, prunePageSources, remapPageSourceIds, withPageSources } from '@/services/page-sources'
import { reconcileSaveAgainstRemote } from '@/services/save-reconcile'
import { isLocalWinningConflict } from '@/services/storage/sync-merge'
import { loadLocalS3Providers, loadS3ProviderMetadata, refreshS3Providers, s3StorageSource, takeS3SourceIdRemap, buildS3SourceIdHealingRemap } from '@/services/s3'
import { captureStartupPages, mergeStartupPages, pageChangedSinceStartup } from '@/services/startup-pages'
import { isCloudStorageSourceId, isLocalStorageSourceId, isTemporaryStorageSourceId } from '@/services/storage-identity'
import { dedupeStorageSources, isWorkspaceFileSource, uniqueSourceIds } from '@/services/storage-sources'
import { sourceStatusStore, syncQueue, storageRegistry } from '@/services/storage'
import { transferPreservesHistory } from '@/services/transfer-policy'
import { isMobileSupportedStorageKind, isMobileSupportedStorageSource, usesMobileUi } from '@/services/platform'
import { migratePageWorkspaceHrefs } from '@/services/link-runtime'
import { runFileHrefMigrationOnce } from '@/services/workspace-migrations'
import { workspaceService } from '@/services/workspace'
import { useBackendStore } from '@/stores/backend'
import { encryptMarkdown, isEncryptedMarkdown, lockAllWorkspaceEncryption } from '@/services/encrypted-markdown'
import { cacheProtectedPage, clearProtectedPages, protectedPageAuthorization, protectedPageView } from '@/services/protected-pages'
import type { SyncConflict, SyncResult } from '@/services/storage/types'
import {
  connectSkill,
  disconnectSkill,
  listSkillConnections,
  type SkillConnection,
} from '@/services/codex-mcp'
import type { Page, PageId, PageLink, PageRevision, PageTreeNode, SearchResult, StorageKind, StorageSource, TagSummary, Workspace } from '@/types'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

interface BackendSyncProgress {
  sourceId: string
  stage: 'connecting' | 'pages' | 'assets' | 'files' | 'reviews'
  completed: number
  total: number
}

function sortSourcesByOrder(sources: StorageSource[], order: string[]) {
  const index = new Map(order.map((id, position) => [id, position]))
  return [...sources].sort((a, b) => {
    const left = index.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const right = index.get(b.id) ?? Number.MAX_SAFE_INTEGER
    return left - right || a.name.localeCompare(b.name, 'zh-CN')
  })
}

/** 未绑定任何云端源：只有本机目录/SMB，不存在跨端「远端」。 */
function pageIsLocalOnly(page: Pick<Page, 'storageSourceId' | 'storageSourceIds'>) {
  return pageSourceIds(page).every((id) => isLocalStorageSourceId(id))
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const backend = useBackendStore()
  function protectionAccountKey() { return JSON.stringify([backend.profile.endpoint, backend.profile.user?.id, Boolean(backend.profile.accessToken)]) }
  watch(protectionAccountKey, () => { clearProtectedPages(); lockAllWorkspaceEncryption() }, { flush: 'sync' })
  const workspace = ref<Workspace | null>(null)
  const pages = ref<Page[]>([])
  const pagesChangingProtection = new Set<PageId>()

  function holdPageForProtectionChange(pageId: PageId) {
    pagesChangingProtection.add(pageId)
    return () => {
      if (pagesChangingProtection.delete(pageId)) void reloadWorkspace()
    }
  }
  const activePageId = ref<PageId | null>(null)
  const storageSourceOrder = ref<string[]>([])
  const showingTrash = ref(false)
  const showingSearch = ref(false)
  const showingTags = ref(false)
  const showingGraph = ref(false)
  const showingRecent = ref(false)
  const showingFavorites = ref(false)
  const showingSkills = ref(false)
  const showingEncryptedDraft = ref(false)
  const encryptedDraftSourceId = ref('')
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
  const initializationStage = ref('正在准备应用…')
  const backgroundStarted = ref(false)
  let editorSaveHandler: (() => Promise<boolean>) | undefined
  function registerEditorSaveHandler(handler: () => Promise<boolean>) {
    editorSaveHandler = handler
    return () => { if (editorSaveHandler === handler) editorSaveHandler = undefined }
  }
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
  let updatingStartupSources = false
  const syncConflictPages = computed(() => [...syncConflicts.value.entries()]
    .map(([pageId, conflict]) => {
      const page = pages.value.find((item) => item.id === pageId)
      const source = allSources.value.find((item) => item.id === conflict.sourceId)
      return page && !page.deletedAt ? { pageId, conflict, page, source } : null
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item)))

  const rawSources = computed(() => dedupeStorageSources([
    ...(workspace.value?.sources ?? []).filter((source) => (
      isWorkspaceFileSource(source) || (!desktopCanSync() && isBackendSourceId(source.id))
    )),
    // 桌面端只显示本地目录，后台由同步进程对齐；网页直接使用后台工作区。
    // 存量直连 S3 只读兼容（设置页已禁止新建）。
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
    const visible = usesMobileUi.value
      ? allSources.value.filter((source) => isMobileSupportedStorageSource(source))
      : allSources.value
    const candidates = visible.filter((source) => !source.temporary)
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
      !source.temporary
      && (source.kind === 'local' || source.kind === 'smb')
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
      const view = protectedPageView(page)
      const matches = [...(view?.markdown ?? '').matchAll(linkPattern)]
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
        const view = protectedPageView(page)
        const body = view?.markdown.replace(/^# .*\n?/, '').toLocaleLowerCase() ?? ''
        const titleScore = title === query ? 120 : title.startsWith(query) ? 90 : title.includes(query) ? 70 : 0
        const tagScore = tagText.includes(query) ? 45 : 0
        const bodyPosition = body.indexOf(query)
        const bodyScore = bodyPosition >= 0 ? Math.max(10, 35 - Math.min(bodyPosition, 25)) : 0
        const previewText = view ? view.markdown.replace(/^# .*\n?/, '').replace(/[#>*_~`|()[\]]/g, ' ').replace(/\s+/g, ' ').trim() : '正文已锁定'
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
    // 内容未变时不要赋新数组，否则设置页模板里 canMove 会在渲染期触发无限更新。
    if (next.length === storageSourceOrder.value.length && next.every((id, index) => id === storageSourceOrder.value[index])) {
      return
    }
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
    // 只读判断，禁止在渲染路径里写 storageSourceOrder。
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
    if (updatingStartupSources || !known.size || !pages.value.length) return
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
    const current = new Map(pages.value.map((page) => [page.id, page]))
    // A conversion dialog must finish authorizing its result before a remote mode change remounts the editor.
    pages.value = mergePagesById(next).map((page) => prunePageSources(
      pagesChangingProtection.has(page.id) ? current.get(page.id) ?? page : page,
      known,
    ))
  }

  async function initialize() {
    try {
      initializationStage.value = '正在读取存储配置…'
      const metadataRemap = await loadS3ProviderMetadata()
      const s3Remap = new Map([
        ...buildS3SourceIdHealingRemap([]),
        ...metadataRemap,
      ])
      initializationStage.value = '正在读取知识库文件…'
      const snapshot = await workspaceService.loadLocal()
      initializationStage.value = '正在恢复页面…'
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
  }

  let backgroundInitialization: Promise<void> | null = null
  function initializeBackground() {
    backgroundStarted.value = true
    if (backgroundInitialization) return backgroundInitialization
    backgroundInitialization = (async () => {
      updatingStartupSources = true
      try {
        await refreshS3Providers({ migrateLegacy: true })
        const remap = new Map([...buildS3SourceIdHealingRemap(pages.value), ...takeS3SourceIdRemap()])
        if (remap.size) {
          setPages(pages.value.map((page) => remapPageSourceIds(page, remap)))
          storageSourceOrder.value = storageSourceOrder.value.map((id) => remap.get(id) ?? id)
          syncStorageSourceOrder()
          persistPreferences()
        }
      } finally {
        updatingStartupSources = false
      }
      await persistLegacyWorkspaceHrefs(captureStartupPages(pages.value))
      await runPendingWorkspaceMigrations()
      await refreshBackendSyncCursor()
      await bootstrapRemoteSync()
    })()
    return backgroundInitialization
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
      const beforeFlush = captureStartupPages(pages.value)
      const flushed = await workspaceService.flushSyncQueue()
      if (flushed.length) {
        setPages(mergeStartupPages(beforeFlush, flushed, pages.value))
      }
      const before = captureStartupPages(pages.value)
      const initialWorkspace = workspace.value
      const { snapshot, syncResults } = await workspaceService.loadWithSync(before)
      if (workspace.value === initialWorkspace) workspace.value = snapshot.workspace
      setPages(mergeStartupPages(before, snapshot.pages, pages.value))
      void persistLegacyWorkspaceHrefs(snapshot.pages)
      applySyncResults(syncResults)
      syncStorageSourceOrder()
    } catch (error) {
      console.warn('远程存储源同步失败', error)
    }
  }

  async function applyWorkspaceReload() {
    const before = captureStartupPages(pages.value)
    const initialWorkspace = workspace.value
    const beforeById = new Map(before.map((page) => [page.id, page]))
    const { snapshot, syncResults } = await workspaceService.loadWithSync(before)
    if (workspace.value === initialWorkspace) workspace.value = snapshot.workspace
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
    setPages(mergeStartupPages(before, [...incoming, ...retained], pages.value))
    void persistLegacyWorkspaceHrefs(incoming)
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
    if (!backend.connected) throw new Error('请先连接云服务')
    const connected = await backend.sync()
    if (!connected) throw new Error(backend.error || '后台同步失败')
    return reloadWorkspace()
  }

  const backendSyncMode = ref<'idle' | 'synced' | 'conflict' | 'error'>('idle')
  const backendSyncRunning = ref(false)
  const backendSyncProgress = ref<BackendSyncProgress | null>(null)
  const backendSyncLastCompletedAt = ref<string | null>(null)
  const backendSyncCursor = ref<Record<string, { local: string; remote: string }>>({})
  let backendSyncWorkspaceId = ''
  let backendSyncFlight: Promise<{ pushed: number; pulled: number; conflicts: string[] }> | null = null
  let backendSyncTimer: number | undefined
  const backendConflictIds = new Set<string>()

  function desktopCanSync() {
    return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  }

  function pickAccountWorkspace(workspaces: { id: string; name: string; default?: boolean }[]) {
    return workspaces.find((item) => item.default)
      ?? workspaces.find((item) => item.name === '我的工作区')
      ?? workspaces[0]
      ?? null
  }

  function syncBackendNow(): Promise<{ pushed: number; pulled: number; conflicts: string[] }> {
    if (backendSyncFlight) return backendSyncFlight
    backendSyncFlight = runBackendSync().finally(() => { backendSyncFlight = null })
    return backendSyncFlight
  }

  function scheduleBackendSync() {
    if (!backend.connected || typeof window === 'undefined') return
    if (!desktopCanSync()) {
      if (backendSyncTimer) window.clearTimeout(backendSyncTimer)
      backendSyncTimer = window.setTimeout(() => {
        backendSyncTimer = undefined
        void reloadWorkspace()
      }, 400)
      return
    }
    if (backendSyncTimer) window.clearTimeout(backendSyncTimer)
    backendSyncTimer = window.setTimeout(() => {
      backendSyncTimer = undefined
      const run = () => {
        void syncBackendNow().catch((error) => {
          backend.error = error instanceof Error ? error.message : '同步失败'
        })
      }
      if (backendSyncFlight) void backendSyncFlight.finally(run)
      else run()
    }, 400)
  }

  async function runBackendSync() {
    const empty = { pushed: 0, pulled: 0, conflicts: [] as string[] }
    if (!backend.connected || !backend.profile.accessToken || !desktopCanSync() || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      backendSyncMode.value = 'idle'
      return empty
    }
    let activeSourceId = ''
    let unlisten: UnlistenFn | undefined
    backendSyncRunning.value = true
    backendSyncProgress.value = null
    try {
      const workspaces = await backendService.listWorkspaces(backend.profile)
      backend.workspaces = workspaces
      const target = pickAccountWorkspace(workspaces)
      if (!target) return empty
      backendSyncWorkspaceId = target.id
      const sources = (workspace.value?.sources ?? []).filter((source) => !source.temporary && (source.kind === 'local' || source.kind === 'smb'))
      let pushed = 0
      let pulled = 0
      const conflicts: string[] = []
      unlisten = await listen<BackendSyncProgress>('backend-sync-progress', ({ payload }) => {
        if (payload.sourceId === activeSourceId) backendSyncProgress.value = payload
      })
      for (const source of sources) {
        activeSourceId = source.id
        backendSyncProgress.value = null
        const report = await invoke<{ pushed: number; pulled: number; conflicts: string[] }>('sync_backend_workspace', {
          sourceId: source.id,
          url: backend.profile.endpoint,
          workspaceId: target.id,
        })
        pushed += report.pushed
        pulled += report.pulled
        conflicts.push(...report.conflicts)
      }
      if (pulled > 0) await reloadWorkspace()
      const next = new Map(syncConflicts.value)
      for (const id of backendConflictIds) {
        if (!conflicts.includes(id)) next.delete(id)
      }
      backendConflictIds.clear()
      for (const id of conflicts) {
        const page = pages.value.find((item) => item.id === id)
        next.set(id, {
          pageId: id,
          sourceId: page?.storageSourceId ?? sources[0]?.id ?? '',
          localUpdatedAt: page?.updatedAt ?? '',
          remoteUpdatedAt: page?.updatedAt ?? '',
        })
        backendConflictIds.add(id)
      }
      syncConflicts.value = next
      backendSyncMode.value = conflicts.length ? 'conflict' : 'synced'
      backend.error = conflicts.length ? '有页面在本地和后台都改过，未覆盖' : ''
      await refreshBackendSyncCursor()
      backendSyncLastCompletedAt.value = new Date().toISOString()
      return { pushed, pulled, conflicts }
    } catch (reason) {
      backendSyncMode.value = 'error'
      backend.error = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '同步失败'
      throw reason
    } finally {
      activeSourceId = ''
      unlisten?.()
      backendSyncProgress.value = null
      backendSyncRunning.value = false
    }
  }

  async function resolveBackendConflict(sourceId: string, pageId: string, keepLocal: boolean) {
    if (!desktopCanSync() || !backendSyncWorkspaceId) return false
    if (backendSyncTimer) {
      window.clearTimeout(backendSyncTimer)
      backendSyncTimer = undefined
    }
    await invoke('resolve_backend_sync_conflict', { sourceId, pageId, keepLocal })
    clearSyncConflict(pageId)
    backendConflictIds.delete(pageId)
    backendSyncMode.value = backendConflictIds.size ? 'conflict' : 'synced'
    if (!backendConflictIds.size) backend.error = ''
    return true
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
        await syncBackendNow()
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
    if (backend.connected) scheduleBackendSync()
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

  function applySnapshot(snapshot: { workspace: Workspace; pages: Page[] }) {
    workspace.value = snapshot.workspace
    setPages(snapshot.pages)
    syncStorageSourceOrder()
    persistPreferences()
  }

  let openFilesFlight: Promise<unknown> = Promise.resolve()
  function openFromFiles(paths?: string[]) {
    const work = openFilesFlight.then(async () => {
      if (editorSaveHandler && !await editorSaveHandler()) return false
      const result = await workspaceService.openMarkdownFiles(paths)
      if (!result) return false
      applySnapshot(result.snapshot)
      const pageId = result.openedPageIds.find((id) => result.snapshot.pages.some((page) => page.id === id && !page.deletedAt))
        ?? result.openedPageIds[0]
        ?? result.snapshot.pages.find((page) => !page.deletedAt)?.id
        ?? null
      if (pageId) activatePage(pageId)
      return true
    })
    openFilesFlight = work.catch(() => undefined)
    return work
  }

  async function openTieEntry() {
    const result = await workspaceService.openTieEntry()
    if (!result) return false
    applySnapshot(result.snapshot)
    const pageId = result.rootPageId && result.snapshot.pages.some((page) => page.id === result.rootPageId && !page.deletedAt)
      ? result.rootPageId
      : result.snapshot.pages.find((page) => !page.deletedAt)?.id ?? null
    if (pageId) openPage(pageId)
    return true
  }

  async function importTiez() {
    const result = await workspaceService.importTiez()
    if (!result) return false
    applySnapshot(result.snapshot)
    const pageId = result.rootPageId && result.snapshot.pages.some((page) => page.id === result.rootPageId && !page.deletedAt)
      ? result.rootPageId
      : result.snapshot.pages.find((page) => !page.deletedAt)?.id ?? null
    if (pageId) openPage(pageId)
    return true
  }

  async function packCurrentSourceTiez(sourceId?: string) {
    const id = sourceId
      ?? activeStorageSourceId.value
      ?? defaultStorageSourceId.value
      ?? allSources.value.find((source) => source.kind === 'local' || source.kind === 'smb')?.id
    if (!id) return false
    const result = await workspaceService.packWorkspaceTiez(id)
    return Boolean(result)
  }

  /** Browser demo: import `.tiez` into localStorage workspace. */
  async function importTiezBrowser() {
    const { pickTiezFile, unpackTiezFile } = await import('@/services/tiez-browser')
    const file = await pickTiezFile()
    if (!file) return false
    const packed = await unpackTiezFile(file)
    const sourceId = 'source-demo-local'
    const name = packed.solutionName || '浏览器演示工作区'
    const snapshot = {
      workspace: {
        id: 'local-demo',
        name,
        sources: [{ id: sourceId, name, path: 'localStorage', kind: 'local' as const, available: true }],
      },
      pages: packed.pages.map((page) => ({
        ...page,
        storageSourceId: sourceId,
        storageSourceIds: [sourceId],
      })),
    }
    localStorage.setItem('tie-demo-workspace-v1', JSON.stringify(snapshot))
    applySnapshot(snapshot)
    const pageId = snapshot.pages.find((page) => !page.deletedAt)?.id ?? null
    if (pageId) openPage(pageId)
    return true
  }

  async function exportTiezBrowser() {
    const { packPagesToTiez, downloadBlob } = await import('@/services/tiez-browser')
    const packed = packPagesToTiez(pages.value, { name: workspace.value?.name })
    downloadBlob(packed.blob, packed.filename)
    return true
  }

  async function removeStorageSource(sourceId: string) {
    if (isTemporaryStorageSourceId(sourceId) && activePage.value && pageBoundToSource(activePage.value, sourceId)) {
      if (editorSaveHandler && !await editorSaveHandler()) return false
    }
    const snapshot = await workspaceService.removeStorageSource(sourceId)
    if (!snapshot) return false
    workspace.value = snapshot.workspace
    setPages(snapshot.pages.filter((page) => !pageBoundToSource(page, sourceId)))
    const available = new Set(pages.value.filter((page) => !page.deletedAt).map((page) => page.id))
    favoritePageIds.value = favoritePageIds.value.filter((id) => available.has(id))
    recentPageIds.value = recentPageIds.value.filter((id) => available.has(id))
    collapsedPageIds.value = collapsedPageIds.value.filter((id) => available.has(id))
    if (activePageId.value && !available.has(activePageId.value)) {
      activePageId.value = recentPageIds.value[0] ?? pages.value.find((page) => !page.deletedAt)?.id ?? null
    }
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
    const temporaryPageIds = new Set(pages.value.filter((page) => isTemporaryStorageSourceId(page.storageSourceId)).map((page) => page.id))
    const temporarySourceIds = new Set(allSources.value.filter((source) => source.temporary).map((source) => source.id))
    workspaceService.savePreferences(workspace.value.id, {
      favoritePageIds: favoritePageIds.value.filter((id) => !temporaryPageIds.has(id)),
      recentPageIds: recentPageIds.value.filter((id) => !temporaryPageIds.has(id)),
      collapsedPageIds: collapsedPageIds.value.filter((id) => !temporaryPageIds.has(id)),
      spellcheckEnabled: spellcheckEnabled.value,
      sourceMode: sourceMode.value,
      storageSourceOrder: storageSourceOrder.value.filter((id) => !temporarySourceIds.has(id)),
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
    if (parent && isTemporaryStorageSourceId(parent.storageSourceId)) throw new Error('临时工作区仅编辑当前文件，请在正式工作区创建页面')
    const fallbackPage = pages.value.find((item) => {
      if (item.deletedAt) return false
      if (isTemporaryStorageSourceId(item.storageSourceId)) return false
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
      throw new Error('请先添加一个工作区')
    }
    const page = await workspaceService.createPage(parentId, storageSourceId)
    pages.value = mergePagesById([...pages.value, page])
    activePageId.value = page.id
    markRecentlyOpened(page.id)
    clearSpecialViews()
    return page
  }

  async function openEncryptedPage() {
    if (editorSaveHandler && !await editorSaveHandler()) return false
    const sourceId = activePage.value?.storageSourceId
    encryptedDraftSourceId.value = sourceId && !isTemporaryStorageSourceId(sourceId) ? sourceId : defaultStorageSourceId.value ?? ''
    clearSpecialViews()
    showingEncryptedDraft.value = true
    return true
  }

  async function createEncryptedPage(title: string, markdown: string, sourceId: string) {
    if (!isEncryptedMarkdown(markdown)) throw new Error('加密页面只能保存密文')
    if (!allSources.value.some((source) => source.id === sourceId && !source.temporary)) throw new Error('请先选择一个正式工作区')
    const account = protectionAccountKey()
    const page = await workspaceService.createPage(null, sourceId, { title: title.trim() || '无标题', markdown })
    if (account !== protectionAccountKey()) return page
    pages.value = mergePagesById([...pages.value, page])
    scheduleBackendSync()
    return page
  }

  function markdownLink(title: string, pageId: PageId) {
    return `[${title.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')}](tie://page/${pageId})`
  }

  function markdownWithTitle(markdown: string, title: string) {
    if (!markdown.startsWith('# ')) return markdown
    return markdown.replace(/^# .*/, `# ${title}`)
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
    if (isTemporaryStorageSourceId(parent.storageSourceId)) throw new Error('临时工作区仅编辑当前文件，请在正式工作区创建页面')
    const child = await workspaceService.createPage(parentId, parent.storageSourceId)
    pages.value.push(child)
    expandPage(parentId)
    activePageId.value = child.id
    markRecentlyOpened(child.id)
    showingTrash.value = false
    return child
  }

  /** 用原文做标题创建子页面，留在父页面，便于正文里就地显示。 */
  async function createChildFromText(parentId: PageId, rawTitle: string) {
    const parent = pages.value.find((page) => page.id === parentId && !page.deletedAt)
    if (!parent) throw new Error('父页面不存在')
    if (isTemporaryStorageSourceId(parent.storageSourceId)) throw new Error('临时工作区仅编辑当前文件，请在正式工作区创建页面')
    const title = rawTitle.trim().replace(/\s+/g, ' ').slice(0, 120)
    if (!title) throw new Error('请先选中要展开的文字')
    const created = await workspaceService.createPage(parentId, parent.storageSourceId)
    const saved = await workspaceService.savePage({
      ...created,
      title,
      markdown: `# ${title}\n\n`,
      updatedAt: new Date().toISOString(),
    })
    const index = pages.value.findIndex((page) => page.id === saved.id)
    if (index === -1) pages.value.push(saved)
    else pages.value[index] = saved
    expandPage(parentId)
    showingTrash.value = false
    return saved
  }

  async function createLinkedPage(title: string) {
    const activeSource = activePage.value?.storageSourceId
    const storageSourceId = activeSource && !isTemporaryStorageSourceId(activeSource) ? activeSource : defaultStorageSourceId.value
    if (!storageSourceId) throw new Error('请先添加一个工作区')
    const created = await workspaceService.createPage(null, storageSourceId)
    const cleanTitle = title.trim() || '无标题'
    const saved = await workspaceService.savePage({ ...created, title: cleanTitle, markdown: `# ${cleanTitle}\n\n`, updatedAt: new Date().toISOString() })
    pages.value.push(saved)
    return saved
  }

  async function duplicatePage(pageId: PageId) {
    const original = pages.value.find((page) => page.id === pageId && !page.deletedAt)
    if (!original) return null
    if (isTemporaryStorageSourceId(original.storageSourceId)) throw new Error('请先将文件导入正式工作区后再复制页面')
    const created = await workspaceService.createPage(original.parentId, original.storageSourceId)
    const title = `${original.title || '无标题'} 副本`
    const hasHeading = original.markdown.startsWith('# ')
    const body = hasHeading ? original.markdown.replace(/^# .*\n?/, '').trimStart() : original.markdown
    const saved = await workspaceService.savePage({
      ...created,
      title,
      markdown: hasHeading ? `# ${title}\n\n${body}` : body,
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
    const source = await pageForLinkWrite(sourcePageId)
    const target = pages.value.find((page) => page.id === targetPageId && !page.deletedAt)
    if (!source || !target || source.id === target.id) return false
    const view = protectedPageView(source)
    if (!view) throw new Error('请先解锁页面')
    const escapedTitle = target.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!escapedTitle) return false
    const mentionPattern = new RegExp(escapedTitle)
    const protectedLinkPattern = /(\[[^\]]*\]\(tie:\/\/page\/[A-Za-z0-9_-]+\))/g
    const parts = view.markdown.split(protectedLinkPattern)
    let linked = false
    const markdown = parts.map((part, index) => {
      if (linked || index % 2 === 1) return part
      if (!mentionPattern.test(part)) return part
      linked = true
      return part.replace(mentionPattern, markdownLink(target.title, target.id))
    }).join('')
    if (!linked) return false
    await persistLinkedPage(source, markdown)
    return true
  }

  async function unlinkPageReference(sourcePageId: PageId, targetPageId: PageId) {
    const source = await pageForLinkWrite(sourcePageId)
    const target = pages.value.find((page) => page.id === targetPageId && !page.deletedAt)
    if (!source || !target) return false
    const view = protectedPageView(source)
    if (!view) throw new Error('请先解锁页面')
    const markdown = unlinkPageMarkdownReference(view.markdown, targetPageId)
    if (markdown === view.markdown) return false
    await persistLinkedPage(source, markdown)
    return true
  }

  async function pageForLinkWrite(pageId: PageId) {
    const current = pages.value.find((page) => page.id === pageId && !page.deletedAt)
    if (current && isEncryptedMarkdown(current.markdown) && editorSaveHandler) {
      if (!await editorSaveHandler()) return undefined
      return pages.value.find((page) => page.id === pageId && !page.deletedAt)
    }
    return current
  }

  async function persistLinkedPage(source: Page, markdown: string) {
    if (!isEncryptedMarkdown(source.markdown)) {
      await persist({ ...source, markdown })
      return
    }
    const permission = protectedPageAuthorization(source)!
    const key = permission.key
    const account = protectionAccountKey()
    const authorized = () => {
      const current = protectedPageAuthorization(source)
      return account === protectionAccountKey() && current?.key === key && current.ciphertext === permission.ciphertext
        && current.generation === permission.generation && current.epoch === permission.epoch
    }
    const ciphertext = await encryptMarkdown(markdown, key)
    if (!authorized()) throw new Error('页面解锁已取消，请重新解锁')
    const current = pages.value.find((page) => page.id === source.id && page.storageSourceId === source.storageSourceId && !page.deletedAt)
    if (!current || current.markdown !== source.markdown) throw new Error('页面已更新，请重新载入后再修改链接')
    await persist({ ...current, markdown: ciphertext })
    const saved = pages.value.find((page) => page.id === source.id && page.storageSourceId === source.storageSourceId && !page.deletedAt)
    if (saved?.markdown === ciphertext && authorized()) cacheProtectedPage(saved, { ...saved, markdown }, key)
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

  async function persist(page: Page, options?: { force?: boolean; restore?: boolean; sync?: boolean; onlyIfUnchanged?: Page }) {
    const prior = persistChains.get(page.id) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const chained = prior.catch(() => undefined).then(() => gate)
    persistChains.set(page.id, chained)
    await prior.catch(() => undefined)
    saving.value = true
    try {
      if (options?.onlyIfUnchanged) {
        const current = pages.value.find((item) => item.id === page.id)
        if (!current || pageChangedSinceStartup(current, options.onlyIfUnchanged)) return
      }
      await persistUnlocked(page, options)
    } finally {
      saving.value = false
      release()
      if (persistChains.get(page.id) === chained) persistChains.delete(page.id)
    }
  }

  async function runPendingWorkspaceMigrations() {
    try {
      const originals = captureStartupPages(pages.value.filter((page) => !isTemporaryStorageSourceId(page.storageSourceId)))
      const before = new Map(originals.map((page) => [page.id, page]))
      await runFileHrefMigrationOnce({
        pages: originals,
        sources: allSources.value.filter((source) => !source.temporary),
        persistPage: async (page) => {
          const original = before.get(page.id)
          if (original) await persist(page, { onlyIfUnchanged: original })
        },
      })
    } catch (error) {
      console.warn('[tie] workspace migration failed', error)
    }
  }

  /** Cheap idempotent sourceId backfill only — not file:/// (that is a one-shot update migration). */
  async function persistLegacyWorkspaceHrefs(originals: Page[]) {
    for (const page of originals) {
      if (page.deletedAt || isTemporaryStorageSourceId(page.storageSourceId)) continue
      const migrated = migratePageWorkspaceHrefs(page)
      if (migrated.markdown === page.markdown) continue
      const current = pages.value.find((item) => item.id === page.id)
      if (current && current.markdown !== page.markdown && current.markdown !== migrated.markdown) continue
      try {
        await persist(migrated, { onlyIfUnchanged: page })
      } catch (error) {
        console.warn('旧工作区链接写回失败', page.id, error)
      }
    }
  }

  async function persistUnlocked(page: Page, options?: { force?: boolean; restore?: boolean; sync?: boolean }) {
    const previous = pages.value.find((item) => item.id === page.id)
    if (previous && isEncryptedMarkdown(previous.markdown) && !isEncryptedMarkdown(page.markdown)) throw new Error('加密页面不能保存为普通明文')
    // Re-check after acquiring the per-page save lock: queued editor drafts
    // must not resurrect a page that was trashed while they were waiting.
    if (previous?.deletedAt && !page.deletedAt && !options?.restore) {
      throw new Error('页面已移入回收站，请先恢复页面再编辑')
    }
    // 树层级只认 parent_id（写在 .tie/meta）；正文里的 tie://page 链接只做关联，不回写子页列表。
    const temporary = isTemporaryStorageSourceId(page.storageSourceId)
    const contentDraft = temporary ? page : migratePageWorkspaceHrefs(page)
    // 无正文/标题/标签/删除态/树结构差异时不写盘、不刷新 updatedAt（避免自动保存空转）。
    if (!options?.force && previous && pageWriteEqual(contentDraft, previous)) {
      return
    }
    const draft = { ...contentDraft, updatedAt: new Date().toISOString() }
    let expectedUpdatedAt = options?.force ? undefined : previous?.updatedAt
    let forceWrite = Boolean(options?.force)
    const localOnly = !temporary && pageIsLocalOnly(previous ?? draft)
    const conflictMessage = temporary
      ? '页面文件已在磁盘上被修改，请重新载入后再保存'
      : '页面已在其他设备更新，请重新载入后再保存'

    // 云端协作冲突：本地领先时禁止静默覆盖。纯本地页没有跨端协作面，直接以编辑器为准。
    if (!forceWrite && syncConflicts.value.has(page.id)) {
      const conflict = syncConflicts.value.get(page.id)
      if (conflict && isLocalWinningConflict(conflict)) {
        if (localOnly) {
          forceWrite = true
          expectedUpdatedAt = undefined
          clearSyncConflict(page.id)
        } else {
          throw new Error(conflictMessage)
        }
      }
    }

    if (!forceWrite && previous) {
      const latest = await workspaceService.readLatestPage(previous).catch(() => null)
      if (latest) {
        const result = reconcileSaveAgainstRemote(previous, draft, latest)
        if (result.action === 'skip') {
          adoptRemotePage(result.page, previous)
          return
        }
        if (result.action === 'conflict') {
          if (localOnly) {
            // 纯本地：差异只是「编辑器里的稿」vs「磁盘上的 md」，以当前编辑为准覆盖。
            forceWrite = true
            expectedUpdatedAt = undefined
            clearSyncConflict(page.id)
          } else {
            registerSyncConflict(page.id, previous.storageSourceId, draft.updatedAt, result.remote.updatedAt)
            throw new Error(conflictMessage)
          }
        } else {
          expectedUpdatedAt = result.expectedUpdatedAt
          if (result.adoptRemoteTimestamp) {
            pages.value = pages.value.map((item) => (
              item.id === page.id ? { ...item, updatedAt: result.adoptRemoteTimestamp! } : item
            ))
          }
        }
      }
    }

    try {
      const saved = await workspaceService.savePage(
        draft,
        { expectedUpdatedAt, force: forceWrite },
      )
      const index = pages.value.findIndex((item) => item.id === saved.id)
      if (index === -1) pages.value.push(saved)
      else pages.value[index] = saved
      clearSyncConflict(saved.id)
      if (options?.sync !== false && !isTemporaryStorageSourceId(saved.storageSourceId)) scheduleBackendSync()
      if (previous && previous.title !== saved.title) {
        const linkPattern = pageLinkPattern(saved.id)
        const targetUrl = `tie://page/${saved.id}`
        const updates = pages.value.filter((item) => item.id !== saved.id && !item.deletedAt && item.markdown.includes(targetUrl)).map((item) => ({ ...item, markdown: item.markdown.replace(linkPattern, markdownLink(saved.title, saved.id)), updatedAt: new Date().toISOString() }))
        if (updates.length) {
          const savedLinks = await Promise.all(updates.map((item) => workspaceService.savePage(item, { force: forceWrite })))
          pages.value = pages.value.map((item) => savedLinks.find((candidate) => candidate.id === item.id) ?? item)
        }
      }
    } catch (error) {
      if (!forceWrite && previous && error instanceof Error && (
        error.message.includes('其他设备')
        || error.message.includes('其他程序')
        || error.message.includes('磁盘上')
      )) {
        const latest = await workspaceService.readLatestPage(previous).catch(() => null)
        if (latest && pageContentEqual(latest, draft)) {
          adoptRemotePage(latest, previous)
          clearSyncConflict(latest.id)
          return
        }
        if (localOnly) {
          // 乐观锁失败：纯本地直接强制覆盖，不再登记「远端冲突」。
          const saved = await workspaceService.savePage(draft, { force: true })
          const index = pages.value.findIndex((item) => item.id === saved.id)
          if (index === -1) pages.value.push(saved)
          else pages.value[index] = saved
          clearSyncConflict(saved.id)
          return
        }
        if (latest) registerSyncConflict(page.id, previous.storageSourceId, draft.updatedAt, latest.updatedAt)
      }
      throw error
    }
  }

  async function resolveConflictOverwriteLocal(page: Page) {
    await persist(page, { force: true, sync: false })
    if (await resolveBackendConflict(page.storageSourceId, page.id, true)) return
  }

  async function resolveConflictLoadRemote(pageId: PageId) {
    const page = pages.value.find((item) => item.id === pageId)
    if (page && await resolveBackendConflict(page.storageSourceId, pageId, false)) {
      await reloadWorkspace()
      return pages.value.find((item) => item.id === pageId) ?? null
    }
    return refreshPage(pageId)
  }

  function canTransferPageTo(targetSourceId: string, fromSourceId = activePage.value?.storageSourceId) {
    if (!fromSourceId || isTemporaryStorageSourceId(fromSourceId) || isTemporaryStorageSourceId(targetSourceId)) return false
    return storageRegistry.canTransfer(fromSourceId, targetSourceId)
  }

  function transferHistoryNotice(fromSourceId: string, toSourceId: string) {
    if (transferPreservesHistory(fromSourceId, toSourceId)) {
      return '页面树、Markdown 文件、历史版本、变更、讨论与图片附件会一并移动。'
    }
    if (isBackendRemoteSourceId(fromSourceId) || isBackendRemoteSourceId(toSourceId)) {
      return '页面正文、变更、讨论与图片附件会迁移；历史版本可能不会完整保留。'
    }
    return '页面正文会迁移，但历史版本与部分附件可能不会完整保留。'
  }

  async function transferPage(pageId: PageId, targetSourceId: string, includeChildren = false) {
    const page = pages.value.find((item) => item.id === pageId)
    if (!page) return false
    if (!canTransferPageTo(targetSourceId, page.storageSourceId)) return false
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
    if (!page) return null
    if (backend.connected && backendSyncWorkspaceId && syncConflicts.value.has(pageId)) {
      try {
        const remote = await backendService.getPage(backend.profile, backendSyncWorkspaceId, pageId)
        return { ...remote, storageSourceId: page.storageSourceId, storageSourceIds: page.storageSourceIds }
      } catch { /* 读不到后台时退回本机副本 */ }
    }
    return workspaceService.readLatestPage(page)
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

  const trashNotice = ref('')
  let trashNoticeTimer: ReturnType<typeof globalThis.setTimeout> | undefined

  async function trashPage(pageId: PageId) {
    const page = pages.value.find((item) => item.id === pageId)
    if (page && isTemporaryStorageSourceId(page.storageSourceId)) {
      await removeStorageSource(page.storageSourceId)
      return
    }
    const removed = collectSubtree(pageId)
    const deletedAt = new Date().toISOString()
    saving.value = true
    try {
      // 树只认 parent_id：软删子树即可，不必改父页正文里的手动链接。
      const updated = await Promise.all(pages.value.filter((page) => removed.has(page.id)).map(async (page) => {
        const next = { ...page, deletedAt, updatedAt: deletedAt }
        await persist(next, { force: true })
        return pages.value.find((item) => item.id === page.id) ?? next
      }))
      pages.value = pages.value.map((page) => updated.find((candidate) => candidate.id === page.id) ?? page)
      if (removed.has(activePageId.value ?? '')) activePageId.value = pages.value.find((page) => !page.deletedAt)?.id ?? null
      trashNotice.value = removed.size > 1 ? `已移到回收站（${removed.size} 页）` : '已移到回收站'
      if (trashNoticeTimer) globalThis.clearTimeout(trashNoticeTimer)
      trashNoticeTimer = globalThis.setTimeout(() => { trashNotice.value = '' }, 4000)
    } finally { saving.value = false }
  }

  function dismissTrashNotice() {
    trashNotice.value = ''
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
      const updated = await Promise.all(pages.value.filter((page) => restored.has(page.id)).map(async (page) => {
        const next = { ...page, parentId: restoreAtTopLevel && page.id === pageId ? null : page.parentId, deletedAt: null, updatedAt }
        await persist(next, { force: true, restore: true })
        return pages.value.find((item) => item.id === page.id) ?? next
      }))
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
    if (!page || isTemporaryStorageSourceId(page.storageSourceId)) return false
    if (parentId) {
      const parent = pages.value.find((item) => item.id === parentId)
      if (!parent || isTemporaryStorageSourceId(parent.storageSourceId)) return false
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
    if (isTemporaryStorageSourceId(target.storageSourceId)) return false
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
    showingEncryptedDraft.value = false
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
    if (activePageId.value !== pageId && editorSaveHandler) {
      return editorSaveHandler().then((saved) => {
        if (saved) activatePage(pageId)
        return saved
      })
    }
    activatePage(pageId)
    return true
  }

  function activatePage(pageId: PageId) {
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

  async function refreshBackendSyncCursor() {
    if (!desktopCanSync()) return
    const sources = (workspace.value?.sources ?? []).filter((source) => !source.temporary && (source.kind === 'local' || source.kind === 'smb'))
    const next: Record<string, { local: string; remote: string }> = {}
    for (const source of sources) {
      try {
        const cursor = await invoke<Record<string, { local: string; remote: string }>>('backend_sync_cursor', { sourceId: source.id })
        Object.assign(next, cursor)
      } catch {
        /* 旧进程还没有这条命令时，列表先不标已同步 */
      }
    }
    backendSyncCursor.value = next
  }

  function pageBackendSync(pageId: PageId | null | undefined): 'synced' | 'pending' | 'conflict' | null {
    const backend = useBackendStore()
    if (!pageId || !backend.connected) return null
    const page = pages.value.find((item) => item.id === pageId)
    if (page && isTemporaryStorageSourceId(page.storageSourceId)) return null
    if (!desktopCanSync()) return page && isBackendSourceId(page.storageSourceId) ? 'synced' : null
    if (syncConflicts.value.has(pageId)) return 'conflict'
    if (pageHasPendingRemoteSave(pageId)) return 'pending'
    if (!page) return null
    const mark = backendSyncCursor.value[pageId]
    if (!mark) return 'pending'
    if (page.updatedAt === mark.local || page.updatedAt === mark.remote) return 'synced'
    return 'pending'
  }

  function pageById(pageId: PageId) { return pages.value.find((page) => page.id === pageId) ?? null }
  function outgoingLinks(pageId: PageId) { return links.value.filter((link) => link.fromPageId === pageId).map((link) => pageById(link.toPageId)).filter((page): page is Page => Boolean(page && !page.deletedAt)) }
  function backlinks(pageId: PageId) { return links.value.filter((link) => link.toPageId === pageId).map((link) => pageById(link.fromPageId)).filter((page): page is Page => Boolean(page && !page.deletedAt)) }
  function unlinkedMentions(pageId: PageId) {
    const page = pageById(pageId)
    if (!page) return []
    const view = protectedPageView(page)
    if (!view) return []
    const linkedPageIds = new Set(outgoingLinks(pageId).map((linked) => linked.id))
    const text = view.markdown
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

  return { workspace, allSources, pages, activePageId, activePage, defaultStorageSourceId, activeStorageSourceId, skillsWorkspaceSource, storageSourceOrder, pendingSyncCount, syncConflictsCount, syncConflictPages, registerEditorSaveHandler, holdPageForProtectionChange, sourceRuntimeStatus, syncConflicts, pageHasPendingRemoteSave, pageBackendSync, saving, reloading, initialized, initializationStage, backgroundStarted, tree, trashedPages, trashNotice, dismissTrashNotice, showingTrash, showingSearch, showingTags, showingGraph, showingRecent, showingFavorites, showingSkills, showingEncryptedDraft, encryptedDraftSourceId, showingSkillManager, activeSkillId, activeSkill, skillConnections, skillsLoading, showingCommandPalette, selectedTag, tagStorageSourceId, tagIndex, taggedPages, searchQuery, searchStorageSourceId, commandQuery, outlineScrollTarget, outlineScrollRequest, searchResults, links, favoritePageIds, favoritePages, recentPageIds, recentPages, collapsedPageIds, spellcheckEnabled, sourceMode, skillsSectionCollapsed, initialize, initializeBackground, reloadWorkspace, syncBackendSources, syncBackendNow, scheduleBackendSync, backendSyncMode, backendSyncRunning, backendSyncProgress, backendSyncLastCompletedAt, syncSource, syncRemoteSources, flushOfflineQueue, addStorageSource, openTieEntry, importTiez, packCurrentSourceTiez, importTiezBrowser, exportTiezBrowser, importMarkdownFiles, openFromFiles, removeStorageSource, renameStorageSource, renameWorkspace, canMoveStorageSource, moveStorageSource, reorderStorageSource, scrollToOutlineHeading, createPage, openEncryptedPage, createEncryptedPage, createChildPage, createChildFromText, createLinkedPage, duplicatePage, renamePage, linkUnlinkedMention, unlinkPageReference, persist, transferPage, canTransferPageTo, transferHistoryNotice, listPageRevisions, readPageRevision, restorePageRevision, exportPageMarkdown, readLatestPage, refreshPage, clearSyncConflict, adoptRemotePage, resolveConflictOverwriteLocal, resolveConflictLoadRemote, trashPage, restorePage, permanentlyDeletePage, emptyTrash, renameTag, deleteTag, movePage, reorderPage, toggleFavorite, toggleSpellcheck, toggleSourceMode, toggleSkillsSectionCollapsed, togglePageCollapsed, expandPage, expandPageAncestors, openPage, openMobileHome, openTrash, openSearch, openTags, openGraph, openRecent, openFavorites, openSkills, openSkillManager, selectSkill, refreshSkills, connectScannedSkill, disconnectManagedSkill, openCommandPalette, closeCommandPalette, outgoingLinks, backlinks, unlinkedMentions }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkspaceStore, import.meta.hot))
}
