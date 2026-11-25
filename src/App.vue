<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import AppSidebar from '@/components/AppSidebar.vue'
import ContextPanel from '@/components/ContextPanel.vue'
import DocumentEditor from '@/components/DocumentEditor.vue'
import MobileHomeView from '@/components/MobileHomeView.vue'
import MobileStackShell from '@/components/MobileStackShell.vue'
import TrashView from '@/components/TrashView.vue'
import SearchView from '@/components/SearchView.vue'
import TagView from '@/components/TagView.vue'
import GraphView from '@/components/GraphView.vue'
import LibraryView from '@/components/LibraryView.vue'
import SkillsView from '@/components/SkillsView.vue'
import CommandPalette from '@/components/CommandPalette.vue'
import BackendConnectionDialog from '@/components/BackendConnectionDialog.vue'
import { temporaryBrowserPages } from '@/services/browser-backend'
import StorageSettingsDialog from '@/components/StorageSettingsDialog.vue'
import AppUpdateDialog from '@/components/AppUpdateDialog.vue'
import PheromoneLinks from '@/components/PheromoneLinks.vue'
import AppIcon from '@/components/AppIcon.vue'
import WebReadView from '@/components/WebReadView.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import { startAutoSync } from '@/services/auto-sync'
import { startBackendLive } from '@/services/backend-live'
import { initializeWorkspaceStartup } from '@/services/startup'
import { backendService } from '@/services/backend'
import { checkForAppUpdateOnStartup } from '@/services/app-updater'
import { installMobileBackHandler, resetMobileBackLeaveArm, uninstallMobileBackHandler } from '@/services/mobile-back'
import { refreshChangeOrigin } from '@/services/pheromone'
import { initPlatform, isMobileClient, isTauriDesktop, usesMobileUi } from '@/services/platform'

const PANEL_WIDTHS_KEY = 'tie:panel-widths'
const SIDEBAR_DEFAULT = 256
const CONTEXT_DEFAULT = 280
const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 480
const CONTEXT_MIN = 260
const CONTEXT_MAX = 420

const store = useWorkspaceStore()
const backend = useBackendStore()
const sidebarCollapsed = ref(false)
const contextCollapsed = ref(false)
const isMobileLayout = ref(false)
const usesContextDrawer = ref(false)
const focusMode = ref(false)
const mobileContextOpen = ref(false)
const backendDialogOpen = ref(false)
const browserTempOffer = ref(false)
const storageSettingsOpen = ref(false)
const updateDialogOpen = ref(false)
const webReadMode = ref(false)
const sidebarWidth = ref(SIDEBAR_DEFAULT)
const contextWidth = ref(CONTEXT_DEFAULT)
const resizingPanel = ref<'sidebar' | 'context' | null>(null)

function syncWebReadMode() {
  webReadMode.value = /#\/read\//.test(window.location.hash) || new URLSearchParams(window.location.search).has('read')
}
let mobileLayoutQuery: MediaQueryList | null = null
let contextDrawerQuery: MediaQueryList | null = null
let resizeStartX = 0
let resizeStartWidth = 0

const usesMobileShell = computed(() => isMobileLayout.value || isMobileClient.value || usesMobileUi.value)

const shellStyle = computed(() => {
  const mobileShell = usesMobileShell.value
  return {
    '--sidebar-width': mobileShell ? `${SIDEBAR_DEFAULT}px` : `${sidebarWidth.value}px`,
    '--context-width': mobileShell ? `${CONTEXT_DEFAULT}px` : `${contextWidth.value}px`,
  }
})

const showSidebarResize = computed(() => !focusMode.value && !sidebarCollapsed.value && !usesMobileShell.value)
const showContextResize = computed(() => !focusMode.value && !contextCollapsed.value && !usesContextDrawer.value)

const mobileOnHome = computed(() => (
  !store.activePageId
  && !store.showingSearch
  && !store.showingTags
  && !store.showingGraph
  && !store.showingTrash
  && !store.showingRecent
  && !store.showingFavorites
  && !store.showingSkills
  && !store.showingSkillManager
))

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function loadPanelWidths() {
  try {
    const raw = localStorage.getItem(PANEL_WIDTHS_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { sidebarWidth?: unknown; contextWidth?: unknown }
    if (typeof parsed.sidebarWidth === 'number' && Number.isFinite(parsed.sidebarWidth)) {
      sidebarWidth.value = clamp(parsed.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX)
    }
    if (typeof parsed.contextWidth === 'number' && Number.isFinite(parsed.contextWidth)) {
      contextWidth.value = clamp(parsed.contextWidth, CONTEXT_MIN, CONTEXT_MAX)
    }
  } catch {
    // keep defaults
  }
}

function savePanelWidths() {
  localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify({
    sidebarWidth: sidebarWidth.value,
    contextWidth: contextWidth.value,
  }))
}

function maxSidebarForViewport() {
  // 右侧进入抽屉后不再占列宽；仍为侧栏+主区预留最小编辑区
  const reserved = usesContextDrawer.value ? 320 : contextWidth.value + 320
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, window.innerWidth - reserved))
}

function maxContextForViewport() {
  return Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, window.innerWidth - sidebarWidth.value - 320))
}

function clampPanelsToViewport() {
  if (usesMobileShell.value) return
  const nextSidebar = clamp(sidebarWidth.value, SIDEBAR_MIN, maxSidebarForViewport())
  const nextContext = clamp(contextWidth.value, CONTEXT_MIN, maxContextForViewport())
  if (nextSidebar !== sidebarWidth.value || nextContext !== contextWidth.value) {
    sidebarWidth.value = nextSidebar
    contextWidth.value = nextContext
    savePanelWidths()
  }
}

function startResize(panel: 'sidebar' | 'context', event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  resizingPanel.value = panel
  resizeStartX = event.clientX
  resizeStartWidth = panel === 'sidebar' ? sidebarWidth.value : contextWidth.value
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  document.body.classList.add('panel-resizing')
}

function onResizeMove(event: PointerEvent) {
  if (!resizingPanel.value) return
  if (resizingPanel.value === 'sidebar') {
    const next = resizeStartWidth + (event.clientX - resizeStartX)
    sidebarWidth.value = clamp(next, SIDEBAR_MIN, maxSidebarForViewport())
    return
  }
  const next = resizeStartWidth - (event.clientX - resizeStartX)
  contextWidth.value = clamp(next, CONTEXT_MIN, maxContextForViewport())
}

function endResize(event: PointerEvent) {
  if (!resizingPanel.value) return
  resizingPanel.value = null
  document.body.classList.remove('panel-resizing')
  try {
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
  } catch {
    // already released
  }
  savePanelWidths()
}

function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value }
function toggleContextPanel() {
  if (usesContextDrawer.value) {
    mobileContextOpen.value = !mobileContextOpen.value
    return
  }
  contextCollapsed.value = !contextCollapsed.value
}

function showChangesPanel() {
  focusMode.value = false
  if (usesContextDrawer.value) mobileContextOpen.value = true
  else contextCollapsed.value = false
}

const mobileBackHint = ref('')
let mobileBackHintTimer: ReturnType<typeof setTimeout> | null = null

function showMobileBackHint(message: string) {
  mobileBackHint.value = message
  if (mobileBackHintTimer) clearTimeout(mobileBackHintTimer)
  mobileBackHintTimer = setTimeout(() => {
    mobileBackHint.value = ''
    mobileBackHintTimer = null
  }, 2200)
}

function goMobileHome() {
  store.openMobileHome()
  mobileContextOpen.value = false
}

function isMobileBackAtHome() {
  return mobileOnHome.value
    && !storageSettingsOpen.value
    && !backendDialogOpen.value
    && !updateDialogOpen.value
    && !store.showingCommandPalette
    && !mobileContextOpen.value
    && !focusMode.value
}

/** 分发可选层关闭；子组件可把 detail.handled 设为 true。 */
function dispatchMobileOverlayBack() {
  const detail = { handled: false }
  window.dispatchEvent(new CustomEvent('tie:mobile-back', { detail }))
  return detail.handled
}

function handleMobileBackNavigation() {
  if (dispatchMobileOverlayBack()) return true
  if (storageSettingsOpen.value) {
    storageSettingsOpen.value = false
    return true
  }
  if (backendDialogOpen.value) {
    backendDialogOpen.value = false
    return true
  }
  if (updateDialogOpen.value) {
    updateDialogOpen.value = false
    return true
  }
  if (store.showingCommandPalette) {
    store.closeCommandPalette()
    return true
  }
  if (mobileContextOpen.value) {
    mobileContextOpen.value = false
    return true
  }
  if (focusMode.value) {
    focusMode.value = false
    return true
  }
  if (!mobileOnHome.value) {
    goMobileHome()
    return true
  }
  return false
}

function ensureMobileBackHandler() {
  if (!usesMobileShell.value) {
    uninstallMobileBackHandler()
    return
  }
  installMobileBackHandler({
    onHome: () => isMobileBackAtHome(),
    goBack: () => handleMobileBackNavigation(),
    showLeaveHint: () => showMobileBackHint('再滑一次返回桌面'),
  })
}

function syncMobileLayout() {
  if (!mobileLayoutQuery) return
  const mobile = mobileLayoutQuery.matches || isMobileClient.value || usesMobileUi.value
  const wasMobile = isMobileLayout.value
  isMobileLayout.value = mobile
  if (mobile) sidebarCollapsed.value = true
  else if (wasMobile) sidebarCollapsed.value = false
  clampPanelsToViewport()
}

function syncContextDrawer() {
  const drawer = (contextDrawerQuery?.matches ?? false) || isMobileClient.value || usesMobileUi.value
  usesContextDrawer.value = drawer
  if (!usesContextDrawer.value) mobileContextOpen.value = false
  clampPanelsToViewport()
}
function toggleFocusMode() {
  focusMode.value = !focusMode.value
  if (focusMode.value) mobileContextOpen.value = false
}
function onShortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
    event.preventDefault()
    store.openCommandPalette()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'Enter') {
    event.preventDefault()
    toggleFocusMode()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key === '\\') {
    event.preventDefault()
    if (!focusMode.value && !usesMobileShell.value) toggleSidebar()
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === '\\') {
    event.preventDefault()
    if (!focusMode.value) toggleContextPanel()
  }
}
function syncViewportHeight() {
  const height = Math.round(window.visualViewport?.height ?? window.innerHeight)
  if (height > 0) {
    document.documentElement.style.setProperty('--app-height', `${height}px`)
  }
}

function onWindowResize() {
  syncViewportHeight()
  clampPanelsToViewport()
}

onMounted(async () => {
  syncWebReadMode()
  window.addEventListener('hashchange', syncWebReadMode)
  loadPanelWidths()
  syncViewportHeight()
  requestAnimationFrame(syncViewportHeight)
  window.setTimeout(syncViewportHeight, 0)
  window.setTimeout(syncViewportHeight, 50)
  window.setTimeout(syncViewportHeight, 200)
  window.setTimeout(syncViewportHeight, 500)
  mobileLayoutQuery = window.matchMedia('(max-width: 720px)')
  contextDrawerQuery = window.matchMedia('(max-width: 1080px)')
  syncMobileLayout()
  syncContextDrawer()
  clampPanelsToViewport()
  mobileLayoutQuery.addEventListener('change', syncMobileLayout)
  contextDrawerQuery.addEventListener('change', syncContextDrawer)
  window.addEventListener('resize', onWindowResize)
  window.visualViewport?.addEventListener('resize', syncViewportHeight)
  window.addEventListener('keydown', onShortcut)
  window.addEventListener('tie:toggle-focus-mode', toggleFocusMode)
  window.addEventListener('tie:show-changes', showChangesPanel)
  await initPlatform()
  syncViewportHeight()
  syncMobileLayout()
  syncContextDrawer()
  await initializeWorkspaceStartup({
    localFirst: isTauriDesktop(),
    initializeWorkspace: () => store.initialize(),
    afterFirstPaint: async () => {
      await nextTick()
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => { requestAnimationFrame(() => resolve()) })
      })
    },
    initializeBackend: async () => {
      await backend.initialize()
      const defaultServer = backend.servers.find((server) => server.defaultPrompt)
      if (defaultServer && !backend.connected && !backendService.isDefaultPromptDismissed()) {
        void backendService.health(defaultServer.endpoint)
          .then(() => { if (!backend.connected) backendDialogOpen.value = true })
          .catch(() => undefined)
      }
    },
    initializeBackground: async () => {
      const work: Promise<unknown>[] = [store.initializeBackground(), refreshChangeOrigin()]
      if (isTauriDesktop() && !isMobileClient.value) work.push(invoke('refresh_startup_integrations'))
      await Promise.all(work)
    },
    onBackendError: (error) => { console.warn('后台连接初始化失败，本地工作区已打开', error) },
    onBackgroundError: (error) => { console.warn('后台维护未完成，本地工作区可继续使用', error) },
  })
  if (!isTauriDesktop() && backend.connected && temporaryBrowserPages().length) browserTempOffer.value = true
  syncViewportHeight()
  if (usesMobileShell.value) goMobileHome()
  ensureMobileBackHandler()
  const update = await checkForAppUpdateOnStartup()
  if (update) updateDialogOpen.value = true
})

watch(
  [
    () => store.initialized && store.backgroundStarted && backend.connected && !backend.loading
      ? `${backend.profile.endpoint}:${backend.profile.user?.id}` : '',
    () => backend.profile.accessToken,
  ],
  ([identity, token], _, onCleanup) => {
    if (!identity || !token) return
    onCleanup(startAutoSync(
      () => store.syncBackendNow(),
      (error) => { backend.error = error instanceof Error ? error.message : '自动同步失败，将自动重试' },
    ))
    onCleanup(startBackendLive({
      endpoint: backend.profile.endpoint,
      token,
      onWorkspace: () => store.scheduleBackendSync(),
    }))
  },
  { immediate: true },
)

watch(usesMobileShell, () => ensureMobileBackHandler())
watch(
  [
    mobileOnHome,
    storageSettingsOpen,
    backendDialogOpen,
    updateDialogOpen,
    () => store.showingCommandPalette,
    mobileContextOpen,
    focusMode,
  ],
  () => {
    // 离开根界面或打开浮层后清掉「再滑一次」，避免之后单次滑动被当成退出。
    if (!isMobileBackAtHome()) resetMobileBackLeaveArm()
  },
)

onBeforeUnmount(() => {
  document.body.classList.remove('panel-resizing')
  window.removeEventListener('hashchange', syncWebReadMode)
  mobileLayoutQuery?.removeEventListener('change', syncMobileLayout)
  contextDrawerQuery?.removeEventListener('change', syncContextDrawer)
  window.removeEventListener('resize', onWindowResize)
  window.visualViewport?.removeEventListener('resize', syncViewportHeight)
  window.removeEventListener('keydown', onShortcut)
  window.removeEventListener('tie:toggle-focus-mode', toggleFocusMode)
  window.removeEventListener('tie:show-changes', showChangesPanel)
  uninstallMobileBackHandler()
  if (mobileBackHintTimer) clearTimeout(mobileBackHintTimer)
})
</script>

<template>
  <div
    v-if="store.initialized"
    class="app-shell"
    :class="{
      'sidebar-collapsed': sidebarCollapsed,
      'context-collapsed': contextCollapsed,
      'focus-mode': focusMode,
      'mobile-shell': usesMobileShell,
      'mobile-client': isMobileClient || usesMobileUi,
      'mobile-notion': usesMobileShell,
    }"
    :style="shellStyle"
  >
  <WebReadView v-if="webReadMode" />
  <!-- 移动端：Notion 式列表 → 点开编辑器 -->
  <template v-else-if="usesMobileShell && !focusMode">
    <MobileHomeView v-if="mobileOnHome" @open-settings="storageSettingsOpen = true" />
    <template v-else>
      <MobileStackShell v-if="store.showingSearch" title="搜索" @back="goMobileHome">
        <SearchView />
      </MobileStackShell>
      <MobileStackShell v-else-if="store.showingGraph" title="图谱" @back="goMobileHome">
        <GraphView />
      </MobileStackShell>
      <MobileStackShell v-else-if="store.showingRecent" title="最近打开" @back="goMobileHome">
        <LibraryView mode="recent" />
      </MobileStackShell>
      <MobileStackShell v-else-if="store.showingFavorites" title="收藏" @back="goMobileHome">
        <LibraryView mode="favorites" />
      </MobileStackShell>
      <MobileStackShell v-else-if="store.showingSkills" title="Agent Skills" @back="goMobileHome">
        <SkillsView />
      </MobileStackShell>
      <MobileStackShell v-else-if="store.showingTags" title="标签" @back="goMobileHome">
        <TagView />
      </MobileStackShell>
      <MobileStackShell v-else-if="store.showingTrash" title="回收站" @back="goMobileHome">
        <TrashView />
      </MobileStackShell>
      <DocumentEditor
        v-else
        mobile-layout
        @mobile-back="goMobileHome"
        @toggle-focus="toggleFocusMode"
        @toggle-context="toggleContextPanel"
      />
    </template>
    <div v-if="mobileContextOpen" class="mobile-context-scrim" @click="mobileContextOpen = false"></div>
    <ContextPanel v-if="mobileContextOpen" class="mobile-context-panel" @close="mobileContextOpen = false" />
  </template>

  <!-- 桌面端：三栏布局 -->
  <template v-else>
    <button v-if="sidebarCollapsed && !focusMode" class="mobile-sidebar-toggle" aria-label="打开侧边栏" @click="toggleSidebar">☰</button>
    <div v-if="isMobileLayout && !sidebarCollapsed && !focusMode" class="mobile-sidebar-scrim" @click="toggleSidebar"></div>
    <AppSidebar v-if="!focusMode" @close="toggleSidebar" @open-storage-settings="storageSettingsOpen = true" />
    <div
      v-if="showSidebarResize"
      class="panel-resize-handle panel-resize-handle-sidebar"
      :class="{ active: resizingPanel === 'sidebar' }"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整左侧栏宽度"
      tabindex="0"
      @pointerdown="startResize('sidebar', $event)"
      @pointermove="onResizeMove"
      @pointerup="endResize"
      @pointercancel="endResize"
    ></div>
    <SearchView v-if="store.showingSearch" />
    <GraphView v-else-if="store.showingGraph" />
    <LibraryView v-else-if="store.showingRecent" mode="recent" />
    <LibraryView v-else-if="store.showingFavorites" mode="favorites" />
    <SkillsView v-else-if="store.showingSkills" />
    <TagView v-else-if="store.showingTags" />
    <TrashView v-else-if="store.showingTrash" />
    <DocumentEditor v-else @toggle-sidebar="toggleSidebar" @toggle-focus="toggleFocusMode" @toggle-context="toggleContextPanel" />
    <div
      v-if="showContextResize"
      class="panel-resize-handle panel-resize-handle-context"
      :class="{ active: resizingPanel === 'context' }"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整右侧栏宽度"
      tabindex="0"
      @pointerdown="startResize('context', $event)"
      @pointermove="onResizeMove"
      @pointerup="endResize"
      @pointercancel="endResize"
    ></div>
    <ContextPanel v-if="!focusMode && !contextCollapsed" @close="toggleContextPanel" />
    <PheromoneLinks />
    <div v-if="mobileContextOpen" class="mobile-context-scrim" @click="mobileContextOpen = false"></div>
    <ContextPanel v-if="mobileContextOpen" class="mobile-context-panel" @close="mobileContextOpen = false" />
  </template>

    <CommandPalette v-if="store.showingCommandPalette" />
    <BackendConnectionDialog v-if="backendDialogOpen || browserTempOffer" :startup-prompt="backend.servers.some((server) => server.defaultPrompt) && !backend.connected" :offer-temporary="browserTempOffer" @close="backendDialogOpen = false; browserTempOffer = false" @temporary-settled="browserTempOffer = false" />
    <StorageSettingsDialog v-if="storageSettingsOpen" @close="storageSettingsOpen = false" @connect-backend="backendDialogOpen = true; storageSettingsOpen = false" />
    <AppUpdateDialog v-if="updateDialogOpen" @close="updateDialogOpen = false" />
    <p v-if="mobileBackHint && usesMobileShell" class="mobile-back-hint" role="status">{{ mobileBackHint }}</p>
  </div>
  <div v-else class="loading-screen" role="status">
    <AppIcon class="loading-mark" :size="30" />
    <p>正在打开知识库…</p>
    <p class="loading-stage">{{ store.initializationStage }}</p>
  </div>
</template>
