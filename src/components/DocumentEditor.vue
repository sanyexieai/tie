<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { useWorkspaceStore } from '@/stores/workspace'
import type { Page } from '@/types'
import TiptapEditor from '@/components/TiptapEditor.vue'
import DocumentMeta from '@/components/DocumentMeta.vue'

const store = useWorkspaceStore()
const title = ref('')
const bodyMarkdown = ref('')
const tags = ref<string[]>([])
const tagDraft = ref('')
const sourceMode = ref(false)
const spellcheckEnabled = ref(true)
const manualSaveNotice = ref(false)
let manualSaveTimer: number | undefined

const status = computed(() => store.saving ? '保存中…' : manualSaveNotice.value ? '已手动保存' : '已保存到本地')
const wordCount = computed(() => bodyMarkdown.value
  .replace(/```[\s\S]*?```/g, '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[#>*_~`|()[\]]/g, ' ')
  .replace(/\s/g, '')
  .length)

function loadActivePage() {
  const page = store.activePage
  title.value = page?.title ?? ''
  bodyMarkdown.value = page?.markdown.replace(/^# .*\n?/, '') ?? ''
  tags.value = page?.tags ?? []
  tagDraft.value = ''
}

watch(() => store.activePageId, loadActivePage, { immediate: true })

const save = useDebounceFn(async (page: Page) => {
  await store.persist(page)
}, 650)

const emit = defineEmits<{ 'toggle-sidebar': [] }>()

function draft() {
  if (!store.activePage) return null
  const cleanTitle = title.value.trim() || '无标题'
  return { ...store.activePage, title: cleanTitle, markdown: `# ${cleanTitle}\n\n${bodyMarkdown.value}`, tags: tags.value }
}

function onInput() {
  const page = draft()
  if (page) void save(page)
}

async function saveNow() {
  const page = draft()
  if (!page) return
  await store.persist(page)
  manualSaveNotice.value = true
  if (manualSaveTimer) window.clearTimeout(manualSaveTimer)
  manualSaveTimer = window.setTimeout(() => { manualSaveNotice.value = false }, 2400)
}

function onBodyChange(markdown: string) {
  bodyMarkdown.value = markdown
  onInput()
}

function onTitleChange(value: string) { title.value = value; onInput() }
function addTags(value: string) {
  const additions = value.split(',').map((tag) => tag.trim()).filter(Boolean)
  if (!additions.length) return
  tags.value = [...new Set([...tags.value, ...additions])]
  tagDraft.value = ''
  onInput()
}
function removeTag(tag: string) { tags.value = tags.value.filter((item) => item !== tag); onInput() }

function navigateToPage(pageId: string) { store.openPage(pageId) }

function toggleSourceMode() { sourceMode.value = !sourceMode.value }

function onShortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 's') {
    event.preventDefault()
    void saveNow()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key === '/') {
    event.preventDefault()
    toggleSourceMode()
  }
}

onMounted(() => window.addEventListener('keydown', onShortcut))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onShortcut)
  if (manualSaveTimer) window.clearTimeout(manualSaveTimer)
})

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
    <div class="editor-scroll">
      <article class="document">
        <div v-if="sourceMode" class="source-editor-panel">
          <DocumentMeta :title="title" :tags="tags" :tag-draft="tagDraft" @update:title="onTitleChange" @update:tag-draft="tagDraft = $event" @add-tags="addTags" @remove-tag="removeTag" />
          <textarea v-model="bodyMarkdown" class="source-editor" aria-label="Markdown 源码" :spellcheck="spellcheckEnabled" @input="onInput"></textarea>
        </div>
        <TiptapEditor v-else :model-value="bodyMarkdown" :pages="store.pages" :page-id="store.activePage.id" :spellcheck="spellcheckEnabled" @update:model-value="onBodyChange" @navigate="navigateToPage" @create-child="createChild">
          <template #meta><DocumentMeta :title="title" :tags="tags" :tag-draft="tagDraft" @update:title="onTitleChange" @update:tag-draft="tagDraft = $event" @add-tags="addTags" @remove-tag="removeTag" /></template>
        </TiptapEditor>
      </article>
    </div>
    <footer class="editor-statusbar">
      <button title="收起或展开左侧栏" @click="emit('toggle-sidebar')">▤ 侧栏</button>
      <button :class="{ active: sourceMode }" title="切换 Markdown 源码模式（Ctrl/Cmd + /）" @click="toggleSourceMode">&lt;/&gt; 源码</button>
      <span class="status-divider"></span>
      <button :class="{ active: spellcheckEnabled }" :title="spellcheckEnabled ? '关闭拼写检查' : '开启拼写检查'" @click="spellcheckEnabled = !spellcheckEnabled">✓ 拼写检查</button>
      <span class="word-count">字数 {{ wordCount }}</span>
    </footer>
  </main>
  <main v-else class="empty-editor"><h1>还没有页面</h1><p>从左侧新建第一个页面，开始你的知识库。</p></main>
</template>
