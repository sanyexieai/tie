<script setup lang="ts">
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
</script>

<template>
  <main class="tag-view">
    <header class="editor-header"><div class="breadcrumbs"><span>我的知识库</span><span>›</span><span>标签</span></div></header>
    <section class="tag-content">
      <p class="eyebrow">标签</p>
      <h1>{{ store.selectedTag ? `# ${store.selectedTag}` : '所有标签' }}</h1>
      <div class="tag-index">
        <button :class="{ active: !store.selectedTag }" @click="store.selectedTag = null">全部 <span>{{ store.tagIndex.length }}</span></button>
        <button v-for="tag in store.tagIndex" :key="tag.name" :class="{ active: store.selectedTag === tag.name }" @click="store.selectedTag = tag.name"># {{ tag.name }} <span>{{ tag.count }}</span></button>
      </div>
      <div v-if="store.selectedTag" class="tagged-pages">
        <button v-for="page in store.taggedPages" :key="page.id" @click="store.openPage(page.id)">
          <strong>{{ page.title }}</strong><span>{{ page.updatedAt.slice(0, 10) }}</span>
        </button>
        <p v-if="!store.taggedPages.length" class="muted">该标签下暂时没有页面。</p>
      </div>
      <p v-else class="tag-instruction">选择一个标签，即可查看关联页面；标签会随页面编辑自动更新。</p>
    </section>
  </main>
</template>
