<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppSidebar from '@/components/AppSidebar.vue'
import ContextPanel from '@/components/ContextPanel.vue'
import DocumentEditor from '@/components/DocumentEditor.vue'
import TrashView from '@/components/TrashView.vue'
import SearchView from '@/components/SearchView.vue'
import TagView from '@/components/TagView.vue'
import GraphView from '@/components/GraphView.vue'
import LibraryView from '@/components/LibraryView.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const sidebarCollapsed = ref(false)
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value }
onMounted(() => {
  sidebarCollapsed.value = window.matchMedia('(max-width: 720px)').matches
  void store.initialize()
})
</script>

<template>
  <div v-if="store.initialized" class="app-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <button v-if="sidebarCollapsed" class="mobile-sidebar-toggle" aria-label="打开侧边栏" @click="toggleSidebar">☰</button>
    <div v-if="!sidebarCollapsed" class="mobile-sidebar-scrim" @click="toggleSidebar"></div>
    <AppSidebar v-if="!sidebarCollapsed" @close="toggleSidebar" />
    <SearchView v-if="store.showingSearch" />
    <GraphView v-else-if="store.showingGraph" />
    <LibraryView v-else-if="store.showingRecent" mode="recent" />
    <LibraryView v-else-if="store.showingFavorites" mode="favorites" />
    <TagView v-else-if="store.showingTags" />
    <TrashView v-else-if="store.showingTrash" />
    <DocumentEditor v-else @toggle-sidebar="toggleSidebar" />
    <ContextPanel />
  </div>
  <div v-else class="loading-screen"><div class="loading-mark">T</div><p>正在打开知识库…</p></div>
</template>
