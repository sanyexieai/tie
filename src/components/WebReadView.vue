<script setup lang="ts">
/**
 * 浏览器/只读阅读面：渲染标准 Markdown 树中的页面，强调可读性，不提供编辑。
 * 通过 hash `#/read/<pageId>` 或 query `?read=<pageId>` 打开。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { simpleMarkdownToHtml } from '@/services/simple-markdown'
import { isEncryptedMarkdown } from '@/services/encrypted-markdown'

const store = useWorkspaceStore()
const pageId = ref<string | null>(null)
const importing = ref(false)
const importError = ref('')

function parseRoute() {
  const hash = window.location.hash || ''
  const hashMatch = hash.match(/#\/read\/([^/?#]+)/)
  if (hashMatch?.[1]) {
    pageId.value = decodeURIComponent(hashMatch[1])
    return
  }
  const query = new URLSearchParams(window.location.search)
  const fromQuery = query.get('read')
  pageId.value = fromQuery ? decodeURIComponent(fromQuery) : null
}

const page = computed(() => {
  if (!pageId.value) return null
  return store.pages.find((item) => item.id === pageId.value && !item.deletedAt) ?? null
})

const bodyHtml = computed(() => {
  if (!page.value) return ''
  if (isEncryptedMarkdown(page.value.markdown)) return '<p>加密 Markdown · 请返回编辑页面并输入密码解锁。</p>'
  // Strip leading H1 (already shown as title)
  const lines = page.value.markdown.split('\n')
  const withoutTitle = lines[0]?.startsWith('# ') ? lines.slice(1).join('\n').replace(/^\n/, '') : page.value.markdown
  return simpleMarkdownToHtml(withoutTitle)
})

const relatedOutgoing = computed(() => (page.value ? store.outgoingLinks(page.value.id) : []))
const hasWorkspace = computed(() => store.pages.some((item) => !item.deletedAt))

onMounted(() => {
  parseRoute()
  window.addEventListener('hashchange', parseRoute)
})

onUnmounted(() => {
  window.removeEventListener('hashchange', parseRoute)
})

watch(pageId, (id) => {
  if (id) store.openPage(id)
})

function openRelated(id: string) {
  pageId.value = id
  window.location.hash = `#/read/${encodeURIComponent(id)}`
}

function exitReadMode() {
  window.location.hash = ''
  parseRoute()
}

async function importTiez() {
  importing.value = true
  importError.value = ''
  try {
    if (await store.importTiezBrowser()) {
      const first = store.pages.find((item) => !item.deletedAt)
      if (first) openRelated(first.id)
    }
  } catch (error) {
    importError.value = error instanceof Error ? error.message : String(error)
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <main class="web-read">
    <header class="web-read-header">
      <strong>Tie · 阅读</strong>
      <small>只读视图 · 标准文档树</small>
      <button type="button" @click="exitReadMode">返回编辑</button>
    </header>
    <article v-if="page" class="web-read-article">
      <h1>{{ page.title || '无标题' }}</h1>
      <p v-if="page.tags.length" class="web-read-tags">{{ page.tags.map((tag) => `#${tag}`).join(' ') }}</p>
      <div class="web-read-body" v-html="bodyHtml"></div>
      <section v-if="relatedOutgoing.length" class="web-read-related">
        <h2>相关页面</h2>
        <button v-for="item in relatedOutgoing" :key="item.id" type="button" @click="openRelated(item.id)">{{ item.title }}</button>
      </section>
    </article>
    <section v-else class="web-read-empty">
      <p v-if="pageId">未找到页面 <code>{{ pageId }}</code>。</p>
      <p v-else>使用 <code>#/read/&lt;pageId&gt;</code> 打开页面，或先导入工作区。</p>
      <div v-if="!hasWorkspace" class="web-read-actions">
        <button type="button" :disabled="importing" @click="importTiez">{{ importing ? '正在导入…' : '导入 .tiez' }}</button>
        <button type="button" @click="exitReadMode">进入编辑演示</button>
      </div>
      <p v-if="importError" class="web-read-error">{{ importError }}</p>
    </section>
  </main>
</template>

<style scoped>
.web-read {
  max-width: 44rem;
  margin: 0 auto;
  padding: 2rem 1.25rem 4rem;
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  line-height: 1.65;
  color: #1c1917;
  background: linear-gradient(180deg, #faf7f2 0%, #f3efe6 100%);
  min-height: 100vh;
}
.web-read-header {
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
  margin-bottom: 2rem;
  border-bottom: 1px solid #d6d0c4;
  padding-bottom: 0.75rem;
}
.web-read-header strong {
  font-size: 1.25rem;
  letter-spacing: 0.02em;
}
.web-read-header small {
  color: #78716c;
  flex: 1;
}
.web-read-header button,
.web-read-actions button {
  font: inherit;
  border: 1px solid #c4b8a5;
  background: #fffdf8;
  border-radius: 6px;
  padding: 0.35rem 0.75rem;
  cursor: pointer;
}
.web-read-article h1 {
  font-size: 2rem;
  margin: 0 0 0.75rem;
  font-weight: 600;
}
.web-read-tags {
  color: #57534e;
  margin-bottom: 1.5rem;
}
.web-read-body {
  font-size: 1.05rem;
}
.web-read-body :deep(h2),
.web-read-body :deep(h3) {
  margin: 1.5rem 0 0.5rem;
}
.web-read-body :deep(p) {
  margin: 0 0 0.85rem;
}
.web-read-body :deep(pre) {
  background: #ebe4d8;
  padding: 0.75rem 1rem;
  overflow: auto;
  border-radius: 6px;
}
.web-read-body :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
}
.web-read-body :deep(a) {
  color: #0f766e;
}
.web-read-related {
  margin-top: 2.5rem;
  padding-top: 1rem;
  border-top: 1px solid #d6d0c4;
}
.web-read-related button {
  display: block;
  text-align: left;
  background: transparent;
  border: 0;
  padding: 0.35rem 0;
  color: #0f766e;
  cursor: pointer;
  font: inherit;
}
.web-read-empty {
  color: #78716c;
}
.web-read-actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 1rem;
}
.web-read-error {
  color: #b91c1c;
  margin-top: 0.75rem;
}
</style>
