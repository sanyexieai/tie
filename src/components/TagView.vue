<script setup lang="ts">
import { computed } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const sourceForPage = computed(() => new Map(store.allSources.map((source) => [source.id, source])))
async function renameSelectedTag() {
  const tag = store.selectedTag
  if (!tag) return
  const scope = store.tagStorageSourceId ? '当前存储源' : '全部存储源'
  const name = window.prompt(`重命名标签 # ${tag}（作用于${scope}）`, tag)
  if (name === null || name.trim() === tag) return
  await store.renameTag(tag, name)
}
async function deleteSelectedTag() {
  const tag = store.selectedTag
  if (!tag) return
  const scope = store.tagStorageSourceId ? '当前存储源' : '全部存储源'
  if (!window.confirm(`从${scope}的页面中移除标签 # ${tag}？页面和正文不会被删除。`)) return
  await store.deleteTag(tag)
}
</script>

<template>
  <main class="tag-view">
    <header class="editor-header"><div class="breadcrumbs"><span>我的知识库</span><span>›</span><span>标签</span></div></header>
    <section class="tag-content">
      <p class="eyebrow">标签</p>
      <div class="tag-title-row"><h1>{{ store.selectedTag ? `# ${store.selectedTag}` : '所有标签' }}</h1><div v-if="store.selectedTag" class="tag-title-actions"><button class="rename-tag-button" :disabled="store.saving" @click="renameSelectedTag">重命名</button><button class="delete-tag-button" :disabled="store.saving" @click="deleteSelectedTag">删除标签</button></div></div>
      <select v-model="store.tagStorageSourceId" class="tag-source-filter" aria-label="筛选存储源"><option :value="null">全部存储源</option><option v-for="source in store.allSources" :key="source.id" :value="source.id">{{ source.kind === 'backend' ? '后台 · ' : source.kind === 's3' ? 'S3 · ' : source.kind === 'smb' ? 'SMB · ' : '本地 · ' }}{{ source.name }}</option></select>
      <div class="tag-index">
        <button :class="{ active: !store.selectedTag }" @click="store.selectedTag = null">全部 <span>{{ store.tagIndex.length }}</span></button>
        <button v-for="tag in store.tagIndex" :key="tag.name" :class="{ active: store.selectedTag === tag.name }" @click="store.selectedTag = tag.name"># {{ tag.name }} <span>{{ tag.count }}</span></button>
      </div>
      <div v-if="store.selectedTag" class="tagged-pages">
        <button v-for="page in store.taggedPages" :key="page.id" @click="store.openPage(page.id)">
          <strong>{{ page.title }}</strong><span>{{ sourceForPage.get(page.storageSourceId)?.kind === 'backend' ? '后台 · ' : sourceForPage.get(page.storageSourceId)?.kind === 's3' ? 'S3 · ' : sourceForPage.get(page.storageSourceId)?.kind === 'smb' ? 'SMB · ' : '本地 · ' }}{{ sourceForPage.get(page.storageSourceId)?.name ?? '未知来源' }} · {{ page.updatedAt.slice(0, 10) }}</span>
        </button>
        <p v-if="!store.taggedPages.length" class="muted">该标签下暂时没有页面。</p>
      </div>
      <p v-else class="tag-instruction">选择一个标签，即可查看关联页面；标签会随页面编辑自动更新。</p>
    </section>
  </main>
</template>
