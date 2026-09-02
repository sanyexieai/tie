<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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
import StorageSettingsDialog from '@/components/StorageSettingsDialog.vue'
import AppUpdateDialog from '@/components/AppUpdateDialog.vue'
import AppIcon from '@/components/AppIcon.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import { checkForAppUpdateOnStartup } from '@/services/app-updater'
import { installMobileBackHandler, uninstallMobileBackHandler } from '@/services/mobile-back'
import { initPlatform, isMobileClient, usesMobileUi } from '@/services/platform'

const PANEL_WIDTHS_KEY = 'tie:panel-widths'
const SIDEBAR_DEFAULT = 256
const CONTEXT_DEFAULT = 244
const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 480
const CONTEXT_MIN = 180
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
const storageSettingsOpen = ref(false)
const updateDialogOpen = ref(false)
const sidebarWidth = ref(SIDEBAR_DEFAULT)
const contextWidth = ref(CONTEXT_DEFAULT)
const resizingPanel = ref<'sidebar' | 'context' | null>(null)
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
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, window.innerWidth - contextWidth.value - 360))
}

function maxContextForViewport() {
  return Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, window.innerWidth - sidebarWidth.value - 360))
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
}

function handleMobileBackNavigation() {
  if (storageSettingsOpen.value) {
    storageSettingsOpen.value = false
    return
  }
  if (backendDialogOpen.value) {
    backendDialogOpen.value = false
    return
  }
  if (updateDialogOpen.value) {
    updateDialogOpen.value = false
    return
  }
  if (store.showingCommandPalette) {
    store.closeCommandPalette()
    return
  }
  if (mobileContextOpen.value) {
    mobileContextOpen.value = false
    return
  }
  if (!mobileOnHome.value) {
    goMobileHome()
  }
}

function syncMobileLayout() {
  if (!mobileLayoutQuery) return
  const mobile = mobileLayoutQuery.matches || isMobileClient.value || usesMobileUi.value
  const wasMobile = isMobileLayout.value
  isMobileLayout.value = mobile
  if (mobile) sidebarCollapsed.value = true
  else if (wasMobile) sidebarCollapsed.value = false
}

function syncContextDrawer() {
  const drawer = (contextDrawerQuery?.matches ?? false) || isMobileClient.value || usesMobileUi.value
  usesContextDrawer.value = drawer
  if (!usesContextDrawer.value) mobileContextOpen.value = false
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
onMounted(async () => {
  loadPanelWidths()
  mobileLayoutQuery = window.matchMedia('(max-width: 720px)')
  contextDrawerQuery = window.matchMedia('(max-width: 1080px)')
  syncMobileLayout()
  syncContextDrawer()
  mobileLayoutQuery.addEventListener('change', syncMobileLayout)
  contextDrawerQuery.addEventListener('change', syncContextDrawer)
  window.addEventListener('keydown', onShortcut)
  window.addEventListener('tie:toggle-focus-mode', toggleFocusMode)
  await initPlatform()
  syncMobileLayout()
  syncContextDrawer()
  await backend.initialize()
  await store.initialize()
  if (usesMobileShell.value) goMobileHome()
  if (usesMobileShell.value) {
    installMobileBackHandler({
      onHome: () => isMobileBackAtHome(),
      goBack: () => handleMobileBackNavigation(),
      showExitHint: () => showMobileBackHint('再按一次退出应用'),
    })
  }
  const update = await checkForAppUpdateOnStartup()
  if (update) updateDialogOpen.value = true
})
onBeforeUnmount(() => {
  document.body.classList.remove('panel-resizing')
  mobileLayoutQuery?.removeEventListener('change', syncMobileLayout)
  contextDrawerQuery?.removeEventListener('change', syncContextDrawer)
  window.removeEventListener('keydown', onShortcut)
  window.removeEventListener('tie:toggle-focus-mode', toggleFocusMode)
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
  <!-- 移动端：Notion 式列表 → 点开编辑器 -->
  <template v-if="usesMobileShell && !focusMode">
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
    <div v-if="mobileContextOpen" class="mobile-context-scrim" @click="mobileContextOpen = false"></div>
    <ContextPanel v-if="mobileContextOpen" class="mobile-context-panel" @close="mobileContextOpen = false" />
  </template>

    <CommandPalette v-if="store.showingCommandPalette" />
    <BackendConnectionDialog v-if="backendDialogOpen" @close="backendDialogOpen = false" />
    <StorageSettingsDialog v-if="storageSettingsOpen" @close="storageSettingsOpen = false" @connect-backend="backendDialogOpen = true; storageSettingsOpen = false" />
    <AppUpdateDialog v-if="updateDialogOpen" @close="updateDialogOpen = false" />
    <p v-if="mobileBackHint && usesMobileShell" class="mobile-back-hint" role="status">{{ mobileBackHint }}</p>
  </div>
  <div v-else class="loading-screen"><AppIcon class="loading-mark" :size="30" /><p>正在打开知识库…</p></div>
</template>
