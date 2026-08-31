<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const input = ref<HTMLInputElement | null>(null)
const selectedIndex = ref(0)
const query = computed(() => store.commandQuery.trim().toLocaleLowerCase())
const pages = computed(() => store.pages
  .filter((page) => !page.deletedAt && (!query.value || `${page.title} ${page.tags.join(' ')}`.toLocaleLowerCase().includes(query.value)))
  .slice(0, 8))
function emitWorkspaceCommand(name: string) { window.dispatchEvent(new Event(name)) }
const actions = computed(() => [
  { id: 'new', label: '新建页面', hint: '在当前存储源创建顶层页面', run: async () => { await store.createPage(null) } },
  { id: 'new-child', label: '新建子页面', hint: '在当前页面下创建子页面', requiresPage: true, run: async () => { if (store.activePage) await store.createChildPage(store.activePage.id) } },
  { id: 'duplicate', label: '复制当前页面', hint: '复制内容、标签和所在页面层级', requiresPage: true, run: async () => { if (store.activePage) await store.duplicatePage(store.activePage.id) } },
  { id: 'favorite', label: store.activePage && store.favoritePageIds.includes(store.activePage.id) ? '取消收藏当前页面' : '收藏当前页面', hint: '将页面加入或移出收藏', requiresPage: true, run: () => { if (store.activePage) store.toggleFavorite(store.activePage.id) } },
  { id: 'find', label: '页面内查找', hint: '在当前页面查找或替换内容', requiresPage: true, run: () => emitWorkspaceCommand('tie:find-in-page') },
  { id: 'source', label: '切换源码模式', hint: '在富文本和 Markdown 源码间切换', requiresPage: true, run: () => emitWorkspaceCommand('tie:toggle-source-mode') },
  { id: 'history', label: '页面历史', hint: '预览或恢复当前页面版本', requiresPage: true, run: () => emitWorkspaceCommand('tie:open-page-history') },
  { id: 'refresh', label: '刷新当前页面', hint: '从存储源重新读取，丢弃未保存修改', requiresPage: true, run: () => emitWorkspaceCommand('tie:refresh-page') },
  { id: 'focus', label: '切换专注模式', hint: '隐藏或恢复左右侧栏', run: () => emitWorkspaceCommand('tie:toggle-focus-mode') },
  { id: 'search', label: '全局搜索', hint: '搜索标题、标签和正文', run: () => store.openSearch() },
  { id: 'tags', label: '标签', hint: '浏览工作区标签', run: () => store.openTags() },
  { id: 'recent', label: '最近打开', hint: '查看最近访问的页面', run: () => store.openRecent() },
  { id: 'favorites', label: '收藏页面', hint: '查看已收藏的页面', run: () => store.openFavorites() },
  { id: 'graph', label: '知识图谱', hint: '浏览全工作区关系网络', run: () => store.openGraph() },
].filter((item) => (!item.requiresPage || store.activePage) && (!query.value || `${item.label} ${item.hint}`.toLocaleLowerCase().includes(query.value))))
const total = computed(() => pages.value.length + actions.value.length)

function sourceLabel(sourceId: string) {
  const source = store.allSources.find((item) => item.id === sourceId)
  return source ? `${source.kind === 'backend' ? '后台' : source.kind === 's3' ? 'S3' : source.kind === 'smb' ? 'SMB' : '本地'} · ${source.name}` : '未知来源'
}
async function select(index: number) {
  const page = pages.value[index]
  if (page) store.openPage(page.id)
  else await actions.value[index - pages.value.length]?.run()
  store.closeCommandPalette()
}
function onKeydown(event: KeyboardEvent) {
  if (!total.value && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) { event.preventDefault(); return }
  if (event.key === 'ArrowDown') { event.preventDefault(); selectedIndex.value = (selectedIndex.value + 1) % total.value }
  else if (event.key === 'ArrowUp') { event.preventDefault(); selectedIndex.value = (selectedIndex.value - 1 + total.value) % total.value }
  else if (event.key === 'Enter') { event.preventDefault(); void select(selectedIndex.value) }
  else if (event.key === 'Escape') { event.preventDefault(); store.closeCommandPalette() }
}
function updateQuery() { selectedIndex.value = 0 }
onMounted(() => void nextTick(() => input.value?.focus()))
</script>

<template>
  <div class="command-palette-backdrop" @mousedown.self="store.closeCommandPalette()">
    <section class="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
      <input ref="input" v-model="store.commandQuery" placeholder="搜索页面或命令…" @input="updateQuery" @keydown="onKeydown" />
      <div v-if="pages.length" class="command-group"><p>页面</p><button v-for="(page, index) in pages" :key="page.id" :class="{ selected: selectedIndex === index }" @click="select(index)"><span>▱</span><strong>{{ page.title }}</strong><small>{{ sourceLabel(page.storageSourceId) }}</small></button></div>
      <div v-if="actions.length" class="command-group"><p>操作</p><button v-for="(action, index) in actions" :key="action.id" :class="{ selected: selectedIndex === pages.length + index }" @click="select(pages.length + index)"><span>⌘</span><strong>{{ action.label }}</strong><small>{{ action.hint }}</small></button></div>
      <p v-if="!total" class="command-empty">没有匹配的页面或命令。</p>
      <footer><span>↑↓ 选择</span><span>Enter 执行</span><span>Esc 关闭</span></footer>
    </section>
  </div>
</template>
