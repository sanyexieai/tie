<script setup lang="ts">
import { ref, watch } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { KeyRound } from '@lucide/vue'
import { useBackendStore } from '@/stores/backend'
import { useWorkspaceStore } from '@/stores/workspace'
import { useCredentialsStore } from '@/stores/credentials'

const backend = useBackendStore()
const store = useWorkspaceStore()
const credentials = useCredentialsStore()
const expanded = ref(Boolean(credentials.entries.length || store.showingCredentials))
const search = useDebounceFn(() => credentials.refresh(), 200)

async function toggle() {
  if (!backend.connected) { await store.openCredentialPage(); return }
  expanded.value = !expanded.value
  if (expanded.value) await credentials.refresh()
}

watch(() => store.showingCredentials, (open) => { if (open) expanded.value = true })
</script>

<template>
  <section class="credential-tree-section">
    <div class="sidebar-section-title">
      <button type="button" class="credential-section-toggle" :aria-expanded="expanded" @click="toggle">
        <span aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span> 凭据页面
      </button>
      <small v-if="credentials.entries.length">{{ credentials.entries.length }}</small>
      <button type="button" aria-label="新建凭据页面" title="新建凭据页面" @click="store.openCredentialPage()">+</button>
    </div>
    <div v-if="expanded && backend.connected" class="credential-tree-content">
      <label v-if="credentials.workspaces.length > 1" class="credential-workspace-label">
        <select aria-label="凭据工作区" :value="credentials.workspaceId" @change="credentials.selectWorkspace(($event.target as HTMLSelectElement).value)">
          <option v-for="workspace in credentials.workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.name }}</option>
        </select>
      </label>
      <input v-model="credentials.query" type="search" class="credential-search" aria-label="搜索凭据页面" placeholder="查找凭据…" @input="search()">
      <p v-if="credentials.error" role="alert">{{ credentials.error }} <button type="button" @click="credentials.refresh">重试</button></p>
      <div role="list" aria-label="凭据页面">
        <button v-for="entry in credentials.entries" :key="entry.id" type="button" class="credential-tree-item"
          :class="{ selected: store.showingCredentials && credentials.activeCredentialId === entry.id }"
          :aria-label="entry.name" @click="store.openCredentialPage(entry.id, entry.workspaceId)">
          <KeyRound :size="14" aria-hidden="true" /><span>{{ entry.name }}</span>
        </button>
      </div>
      <p v-if="credentials.loading" role="status">正在读取…</p>
      <p v-else-if="!credentials.entries.length && credentials.query">没有匹配的凭据</p>
      <button v-else-if="!credentials.entries.length" type="button" class="credential-empty" @click="store.openCredentialPage()">添加第一张凭据页面…</button>
    </div>
  </section>
</template>

<style scoped>
.credential-section-toggle { flex: 1; text-align: left; }
.credential-tree-content { padding: 0 8px 8px; max-height: 32vh; overflow-y: auto; }
.credential-search { box-sizing: border-box; width: calc(100% - 12px); margin: 0 6px 5px; border: 1px solid var(--border); border-radius: 5px; padding: 5px; color: var(--text); background: var(--bg-sidebar); font-size: 12px; }
.credential-workspace-label { display: block; padding: 0 6px 5px; }
.credential-workspace-label select { width: 100%; min-width: 0; color: var(--text-muted); background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 5px; padding: 4px; font-size: 11px; }
.credential-tree-item { width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 0; border-radius: 5px; text-align: left; color: var(--text-muted); background: transparent; cursor: pointer; }
.credential-tree-item span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.credential-tree-item:hover, .credential-tree-item.selected { background: var(--bg-hover); color: var(--text); }
.credential-tree-content p, .credential-empty { margin: 4px 6px; font-size: 12px; color: var(--text-muted); }
.credential-empty { border: 0; background: transparent; cursor: pointer; padding: 5px 0; }
</style>
