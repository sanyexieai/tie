<script setup lang="ts">
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()

async function restore(pageId: string) { await store.restorePage(pageId) }
async function permanentlyDelete(pageId: string, title: string) {
  if (!window.confirm(`彻底删除“${title}”？此操作会删除 Markdown 文件及其历史版本，无法恢复。`)) return
  await store.permanentlyDeletePage(pageId)
}
async function emptyTrash() {
  const count = store.trashedPages.length
  if (!count || !window.confirm(`清空回收站中的 ${count} 个页面？所有 Markdown 文件与历史版本都会被删除，无法恢复。`)) return
  await store.emptyTrash()
}
</script>

<template>
  <main class="trash-view">
    <header class="editor-header"><div class="breadcrumbs"><span>我的知识库</span><span>›</span><span>回收站</span></div></header>
    <section class="trash-content">
      <p class="eyebrow">回收站</p>
      <div class="trash-title-row"><h1>已删除页面</h1><button v-if="store.trashedPages.length" class="danger empty-trash-button" :disabled="store.saving" @click="emptyTrash">{{ store.saving ? '正在清空…' : '清空回收站' }}</button></div>
      <p class="trash-description">恢复一个页面时，其已删除的子页面也会一并恢复。页面仍保留在 Markdown 工作区中，不会立即永久删除。</p>
      <div v-if="store.trashedPages.length" class="trash-list">
        <article v-for="page in store.trashedPages" :key="page.id">
          <div><strong>{{ page.title }}</strong><span>删除于 {{ page.deletedAt?.slice(0, 10) }}</span></div>
          <div class="trash-actions"><button @click="restore(page.id)">恢复</button><button class="danger" @click="permanentlyDelete(page.id, page.title)">彻底删除</button></div>
        </article>
      </div>
      <div v-else class="trash-empty">回收站为空。</div>
    </section>
  </main>
</template>
