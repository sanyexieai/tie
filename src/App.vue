<script setup lang="ts">
import { onMounted } from 'vue'
import AppSidebar from '@/components/AppSidebar.vue'
import ContextPanel from '@/components/ContextPanel.vue'
import DocumentEditor from '@/components/DocumentEditor.vue'
import TrashView from '@/components/TrashView.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
onMounted(() => void store.initialize())
</script>

<template>
  <div v-if="store.initialized" class="app-shell">
    <AppSidebar />
    <TrashView v-if="store.showingTrash" />
    <DocumentEditor v-else />
    <ContextPanel />
  </div>
  <div v-else class="loading-screen"><div class="loading-mark">T</div><p>正在打开知识库…</p></div>
</template>
