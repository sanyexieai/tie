<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const input = ref<HTMLInputElement | null>(null)
onMounted(() => void nextTick(() => input.value?.focus()))
</script>

<template>
  <main class="search-view">
    <header class="editor-header"><div class="breadcrumbs"><span>我的知识库</span><span>›</span><span>搜索</span></div></header>
    <section class="search-content">
      <p class="eyebrow">全局搜索</p>
      <h1>查找你的知识</h1>
      <input ref="input" v-model="store.searchQuery" class="search-input" placeholder="搜索标题、标签和正文…" />
      <p v-if="!store.searchQuery" class="search-hint">输入关键词开始搜索。标题匹配和标签匹配会优先显示。</p>
      <p v-else class="search-summary">找到 {{ store.searchResults.length }} 个页面</p>
      <div class="search-results">
        <button v-for="result in store.searchResults" :key="result.page.id" @click="store.openPage(result.page.id)">
          <div><strong>{{ result.page.title }}</strong><span v-if="result.page.tags.length">{{ result.page.tags.map((tag) => `#${tag}`).join('  ') }}</span></div>
          <p>{{ result.snippet || '页面没有可预览的正文。' }}</p>
        </button>
      </div>
    </section>
  </main>
</template>
