<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppSidebar from '@/components/AppSidebar.vue'
import ContextPanel from '@/components/ContextPanel.vue'
import DocumentEditor from '@/components/DocumentEditor.vue'
import TrashView from '@/components/TrashView.vue'
import SearchView from '@/components/SearchView.vue'
import TagView from '@/components/TagView.vue'
import GraphView from '@/components/GraphView.vue'
import LibraryView from '@/components/LibraryView.vue'
import CommandPalette from '@/components/CommandPalette.vue'
import BackendConnectionDialog from '@/components/BackendConnectionDialog.vue'
import StorageSettingsDialog from '@/components/StorageSettingsDialog.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'

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
let mobileLayoutQuery: MediaQueryList | null = null
let contextDrawerQuery: MediaQueryList | null = null

function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value }
function toggleContextPanel() {
  if (usesContextDrawer.value) {
    mobileContextOpen.value = !mobileContextOpen.value
    return
  }
  contextCollapsed.value = !contextCollapsed.value
}

function syncMobileLayout() {
  if (!mobileLayoutQuery) return
  const mobile = mobileLayoutQuery.matches
  const wasMobile = isMobileLayout.value
  isMobileLayout.value = mobile
  if (mobile) sidebarCollapsed.value = true
  else if (wasMobile) sidebarCollapsed.value = false
}

function syncContextDrawer() {
  if (!contextDrawerQuery) return
  usesContextDrawer.value = contextDrawerQuery.matches
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
    if (!focusMode.value) toggleSidebar()
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === '\\') {
    event.preventDefault()
    if (!focusMode.value) toggleContextPanel()
  }
}
onMounted(async () => {
  mobileLayoutQuery = window.matchMedia('(max-width: 720px)')
  contextDrawerQuery = window.matchMedia('(max-width: 1080px)')
  syncMobileLayout()
  syncContextDrawer()
  mobileLayoutQuery.addEventListener('change', syncMobileLayout)
  contextDrawerQuery.addEventListener('change', syncContextDrawer)
  window.addEventListener('keydown', onShortcut)
  window.addEventListener('tie:toggle-focus-mode', toggleFocusMode)
  await backend.initialize()
  await store.initialize()
})
onBeforeUnmount(() => {
  mobileLayoutQuery?.removeEventListener('change', syncMobileLayout)
  contextDrawerQuery?.removeEventListener('change', syncContextDrawer)
  window.removeEventListener('keydown', onShortcut)
  window.removeEventListener('tie:toggle-focus-mode', toggleFocusMode)
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
    }"
  >
    <button v-if="sidebarCollapsed && !focusMode" class="mobile-sidebar-toggle" aria-label="打开侧边栏" @click="toggleSidebar">☰</button>
    <div v-if="isMobileLayout && !sidebarCollapsed && !focusMode" class="mobile-sidebar-scrim" @click="toggleSidebar"></div>
    <AppSidebar v-if="!focusMode" @close="toggleSidebar" @open-storage-settings="storageSettingsOpen = true" />
    <SearchView v-if="store.showingSearch" />
    <GraphView v-else-if="store.showingGraph" />
    <LibraryView v-else-if="store.showingRecent" mode="recent" />
    <LibraryView v-else-if="store.showingFavorites" mode="favorites" />
    <TagView v-else-if="store.showingTags" />
    <TrashView v-else-if="store.showingTrash" />
    <DocumentEditor v-else @toggle-sidebar="toggleSidebar" @toggle-focus="toggleFocusMode" @toggle-context="toggleContextPanel" />
    <ContextPanel v-if="!focusMode && !contextCollapsed" @close="toggleContextPanel" />
    <div v-if="mobileContextOpen" class="mobile-context-scrim" @click="mobileContextOpen = false"></div>
    <ContextPanel v-if="mobileContextOpen" class="mobile-context-panel" @close="mobileContextOpen = false" />
    <CommandPalette v-if="store.showingCommandPalette" />
    <BackendConnectionDialog v-if="backendDialogOpen" @close="backendDialogOpen = false" />
    <StorageSettingsDialog v-if="storageSettingsOpen" @close="storageSettingsOpen = false" @connect-backend="backendDialogOpen = true; storageSettingsOpen = false" />
  </div>
  <div v-else class="loading-screen"><div class="loading-mark">T</div><p>正在打开知识库…</p></div>
</template>
