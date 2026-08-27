<script setup lang="ts">
import { computed } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'

const props = defineProps<{ mode: 'recent' | 'favorites' }>()
const store = useWorkspaceStore()
const isRecent = computed(() => props.mode === 'recent')
const title = computed(() => isRecent.value ? '最近打开' : '收藏')
const pages = computed(() => isRecent.value ? store.recentPages : store.favoritePages)
</script>

<template>
  <main class="library-view">
    <header class="editor-header"><div class="breadcrumbs"><span>我的知识库</span><span>›</span><span>{{ title }}</span></div></header>
    <section class="library-content">
      <p class="eyebrow">{{ isRecent ? '最近访问' : '快捷访问' }}</p>
      <h1>{{ title }}</h1>
      <p class="library-description">{{ isRecent ? '按最近打开时间保留的页面，最多显示 15 个。' : '把常用页面收藏起来，方便随时回到这里。' }}</p>
      <div v-if="pages.length" class="library-list">
        <button v-for="page in pages" :key="page.id" @click="store.openPage(page.id)">
          <div><strong>{{ page.title }}</strong><span v-if="page.tags.length">{{ page.tags.map((tag) => `#${tag}`).join(' ') }}</span></div>
          <small>更新于 {{ page.updatedAt.slice(0, 10) }}</small>
        </button>
      </div>
      <p v-else class="library-empty">{{ isRecent ? '打开过的页面会显示在这里。' : '在页面右上角点击“收藏页面”即可添加。' }}</p>
    </section>
  </main>
</template>
