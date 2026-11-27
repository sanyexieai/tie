<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import TieSelect from '@/components/TieSelect.vue'
import SearchUnlockDialog from '@/components/SearchUnlockDialog.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import { isEncryptedMarkdown } from '@/services/encrypted-markdown'
import { protectedPageView } from '@/services/protected-pages'
import { pageBoundToSource } from '@/services/page-sources'

const store = useWorkspaceStore()
const backend = useBackendStore()
const input = ref<HTMLInputElement | null>(null)
const selectedIndex = ref(0)
const unlockOpen = ref(false)
const unlockNotice = ref('')
const lockedPages = computed(() => store.pages.filter((page) => !page.deletedAt && isEncryptedMarkdown(page.markdown)
  && (!store.searchStorageSourceId || pageBoundToSource(page, store.searchStorageSourceId)) && !protectedPageView(page)))
const sourceOptions = computed(() => [
  { value: null as string | null, label: '全部工作区' },
  ...store.allSources.map((source) => ({
    value: source.id as string | null,
    label: source.name,
  })),
])

function resetSelection() { selectedIndex.value = 0 }
function unlocked(count: number) {
  resetSelection()
  unlockNotice.value = `已解锁 ${count} 页，其余 ${lockedPages.value.length} 页仍锁定`
}
watch(() => JSON.stringify([store.searchStorageSourceId, backend.profile.endpoint, backend.profile.user?.id, Boolean(backend.profile.accessToken)]), () => {
  unlockOpen.value = false
  unlockNotice.value = ''
  resetSelection()
})
function openResult(index: number) {
  const result = store.searchResults[index]
  if (result) store.openPage(result.page.id)
}
function onKeydown(event: KeyboardEvent) {
  const count = store.searchResults.length
  if (!count && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) { event.preventDefault(); return }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    selectedIndex.value = (selectedIndex.value + 1) % count
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    selectedIndex.value = (selectedIndex.value - 1 + count) % count
  } else if (event.key === 'Enter') {
    event.preventDefault()
    openResult(selectedIndex.value)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    if (store.activePage) store.openPage(store.activePage.id)
    else store.showingSearch = false
  }
}
onMounted(() => void nextTick(() => input.value?.focus()))
</script>

<template>
  <main class="search-view">
    <header class="editor-header"><div class="breadcrumbs"><span>{{ store.workspace?.name ?? '我的知识库' }}</span><span>›</span><span>搜索</span></div></header>
    <section class="search-content">
      <p class="eyebrow">全局搜索</p>
      <h1>查找你的知识</h1>
      <div class="search-controls"><input ref="input" v-model="store.searchQuery" class="search-input" placeholder="搜索标题、标签和正文…" @input="resetSelection" @keydown="onKeydown" /><TieSelect v-model="store.searchStorageSourceId" :options="sourceOptions" aria-label="筛选工作区" @change="resetSelection" /></div>
      <div v-if="lockedPages.length || unlockNotice" class="search-protection-hint">
        <span v-if="lockedPages.length">{{ lockedPages.length }} 页正文已锁定</span>
        <button v-if="lockedPages.length" type="button" @click="unlockOpen = true">解锁正文搜索</button>
        <span v-if="unlockNotice" role="status">{{ unlockNotice }}</span>
      </div>
      <p v-if="!store.searchQuery" class="search-hint">输入关键词开始搜索。标题匹配和标签匹配会优先显示。</p>
      <p v-else class="search-summary">找到 {{ store.searchResults.length }} 个页面</p>
      <div class="search-results">
        <button v-for="(result, index) in store.searchResults" :key="result.page.id" :class="{ selected: index === selectedIndex }" @click="openResult(index)">
          <div><strong>{{ result.page.title }}</strong><span v-if="result.page.tags.length">{{ result.page.tags.map((tag) => `#${tag}`).join('  ') }}</span><small class="search-source" :class="result.sourceKind">{{ result.sourceName }}</small></div>
          <p>{{ result.snippet || '页面没有可预览的正文。' }}</p>
        </button>
      </div>
    </section>
    <SearchUnlockDialog v-if="unlockOpen" :pages="lockedPages" :source-id="store.searchStorageSourceId" @close="unlockOpen = false" @unlocked="unlocked" />
  </main>
</template>

<style scoped>
.search-protection-hint { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; color: var(--text-faint); font-size: 11px; line-height: 1.6; }
.search-protection-hint button { border: 0; border-radius: 4px; padding: 3px 6px; color: var(--text-muted); background: transparent; font-size: 11px; }
.search-protection-hint button:hover { color: var(--accent-strong); background: var(--accent-soft); }
</style>
