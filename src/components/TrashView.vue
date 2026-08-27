<script setup lang="ts">
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()

async function restore(pageId: string) { await store.restorePage(pageId) }
</script>

<template>
  <main class="trash-view">
    <header class="editor-header"><div class="breadcrumbs"><span>我的知识库</span><span>›</span><span>回收站</span></div></header>
    <section class="trash-content">
      <p class="eyebrow">回收站</p>
      <h1>已删除页面</h1>
      <p class="trash-description">恢复一个页面时，其已删除的子页面也会一并恢复。页面仍保留在 Markdown 工作区中，不会立即永久删除。</p>
      <div v-if="store.trashedPages.length" class="trash-list">
        <article v-for="page in store.trashedPages" :key="page.id">
          <div><strong>{{ page.title }}</strong><span>删除于 {{ page.deletedAt?.slice(0, 10) }}</span></div>
          <button @click="restore(page.id)">恢复</button>
        </article>
      </div>
      <div v-else class="trash-empty">回收站为空。</div>
    </section>
  </main>
</template>
