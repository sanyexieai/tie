<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const input = ref<HTMLInputElement | null>(null)
const selectedIndex = ref(0)

function resetSelection() { selectedIndex.value = 0 }
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
      <div class="search-controls"><input ref="input" v-model="store.searchQuery" class="search-input" placeholder="搜索标题、标签和正文…" @input="resetSelection" @keydown="onKeydown" /><select v-model="store.searchStorageSourceId" aria-label="筛选存储源" @change="resetSelection"><option :value="null">全部存储源</option><option v-for="source in store.workspace?.sources" :key="source.id" :value="source.id">{{ source.kind === 'smb' ? 'SMB · ' : '本地 · ' }}{{ source.name }}</option></select></div>
      <p v-if="!store.searchQuery" class="search-hint">输入关键词开始搜索。标题匹配和标签匹配会优先显示。</p>
      <p v-else class="search-summary">找到 {{ store.searchResults.length }} 个页面</p>
      <div class="search-results">
        <button v-for="(result, index) in store.searchResults" :key="result.page.id" :class="{ selected: index === selectedIndex }" @click="openResult(index)">
          <div><strong>{{ result.page.title }}</strong><span v-if="result.page.tags.length">{{ result.page.tags.map((tag) => `#${tag}`).join('  ') }}</span><small class="search-source" :class="result.sourceKind">{{ result.sourceKind === 'smb' ? 'SMB · ' : '本地 · ' }}{{ result.sourceName }}</small></div>
          <p>{{ result.snippet || '页面没有可预览的正文。' }}</p>
        </button>
      </div>
    </section>
  </main>
</template>
