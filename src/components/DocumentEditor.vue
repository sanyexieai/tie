<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { useWorkspaceStore } from '@/stores/workspace'
import type { Page } from '@/types'
import TiptapEditor from '@/components/TiptapEditor.vue'

const store = useWorkspaceStore()
const title = ref('')
const bodyMarkdown = ref('')
const tagsInput = ref('')

const status = computed(() => store.saving ? '保存中…' : '已保存到本地')

watch(() => store.activePage, (page) => {
  title.value = page?.title ?? ''
  bodyMarkdown.value = page?.markdown.replace(/^# .*\n?/, '') ?? ''
  tagsInput.value = page?.tags.join(', ') ?? ''
}, { immediate: true })

const save = useDebounceFn(async (page: Page) => {
  await store.persist(page)
}, 650)

function draft() {
  if (!store.activePage) return null
  const cleanTitle = title.value.trim() || '无标题'
  const tags = tagsInput.value.split(',').map((tag) => tag.trim()).filter(Boolean)
  return { ...store.activePage, title: cleanTitle, markdown: `# ${cleanTitle}\n\n${bodyMarkdown.value}`, tags }
}

function onInput() {
  const page = draft()
  if (page) void save(page)
}

function onBodyChange(markdown: string) {
  bodyMarkdown.value = markdown
  onInput()
}

function navigateToPage(pageId: string) { store.openPage(pageId) }

async function createChild() {
  if (store.activePage) await store.createChildPage(store.activePage.id)
}
</script>

<template>
  <main v-if="store.activePage" class="editor-pane">
    <header class="editor-header">
      <div class="breadcrumbs"><span>我的知识库</span><span>›</span><span>{{ store.activePage.title }}</span></div>
      <div class="save-state"><span class="save-dot" :class="{ saving: store.saving }"></span>{{ status }} <button title="更多操作">···</button></div>
    </header>
    <article class="document">
      <input v-model="title" class="document-title" aria-label="页面标题" placeholder="无标题" @input="onInput" />
      <div class="tag-row">
        <span v-for="tag in tagsInput.split(',').map((item) => item.trim()).filter(Boolean)" :key="tag" class="tag"># {{ tag }}</span>
        <input v-model="tagsInput" class="tag-input" placeholder="添加标签（逗号分隔）" @input="onInput" />
      </div>
      <TiptapEditor :model-value="bodyMarkdown" :pages="store.pages" :page-id="store.activePage.id" @update:model-value="onBodyChange" @navigate="navigateToPage" @create-child="createChild" />
      <button class="create-child-page-button" @click="createChild">+ 在此页面内创建子页面</button>
    </article>
  </main>
  <main v-else class="empty-editor"><h1>还没有页面</h1><p>从左侧新建第一个页面，开始你的知识库。</p></main>
</template>
