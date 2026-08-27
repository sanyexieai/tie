<script setup lang="ts">
import { computed, ref } from 'vue'
import PageTreeItem from '@/components/PageTreeItem.vue'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const rootPage = computed(() => store.tree.find((node) => node.title === '收集箱'))
const otherPages = computed(() => store.tree.filter((node) => node.id !== rootPage.value?.id))
const topLevelDragOver = ref(false)
const choosingWorkspace = ref(false)
const storageMenuOpen = ref(false)
const emit = defineEmits<{ close: [] }>()
const sources = computed(() => store.workspace?.sources ?? [])
const sourcesById = computed(() => Object.fromEntries(sources.value.map((source) => [source.id, source])))

async function createTopLevel() { await store.createPage(null) }
async function createChild(parentId: string) { await store.createChildPage(parentId) }
async function remove(pageId: string) {
  if (store.pages.length <= 1) return
  await store.trashPage(pageId)
}
async function move(pageId: string, parentId: string) { await store.movePage(pageId, parentId) }
async function reorder(pageId: string, targetId: string, position: 'before' | 'after') { await store.reorderPage(pageId, targetId, position) }
async function dropAtTopLevel(event: DragEvent) {
  const pageId = event.dataTransfer?.getData('text/plain')
  topLevelDragOver.value = false
  if (pageId) await store.movePage(pageId, null)
}
async function chooseWorkspace(kind: 'local' | 'smb') {
  choosingWorkspace.value = true
  try { await store.addStorageSource(kind); storageMenuOpen.value = false } finally { choosingWorkspace.value = false }
}
function sourceLabel(kind: 'local' | 'smb') { return kind === 'smb' ? 'SMB 挂载目录' : '本地目录' }
</script>

<template>
  <aside class="sidebar">
    <div class="workspace-heading">
      <span class="workspace-mark">T</span>
      <span>{{ store.workspace?.name ?? '加载中…' }}</span>
      <button class="ghost-button">⌄</button>
      <button class="mobile-sidebar-close" aria-label="关闭侧边栏" @click="emit('close')">×</button>
    </div>

    <button class="new-page-button" @click="createTopLevel"><span>+</span> 新建页面</button>

    <nav class="quick-nav" aria-label="快捷导航">
      <button :class="{ selected: !store.showingTrash && rootPage?.id === store.activePageId }" @click="rootPage && store.openPage(rootPage.id)"><span>⌑</span> 收集箱</button>
      <button :class="{ selected: store.showingRecent }" @click="store.openRecent()"><span>◷</span> 最近打开</button>
      <button :class="{ selected: store.showingFavorites }" @click="store.openFavorites()"><span>☆</span> 收藏</button>
      <button :class="{ selected: store.showingSearch }" @click="store.openSearch()"><span>⌕</span> 搜索</button>
      <button :class="{ selected: store.showingTags }" @click="store.openTags()"><span>#</span> 标签</button>
      <button :class="{ selected: store.showingGraph }" @click="store.openGraph()"><span>◌</span> 图谱</button>
      <button :class="{ selected: store.showingTrash }" @click="store.openTrash()"><span>⌫</span> 回收站</button>
    </nav>

    <div class="sidebar-section-title"><span>我的页面</span><button @click="createTopLevel">+</button></div>
    <div class="page-tree">
      <div
        class="top-level-drop-zone"
        :class="{ visible: topLevelDragOver }"
        @dragenter.prevent="topLevelDragOver = true"
        @dragover.prevent
        @dragleave="topLevelDragOver = false"
        @drop.prevent="dropAtTopLevel"
      >拖到这里设为顶层页面</div>
      <PageTreeItem
        v-for="node in otherPages"
        :key="node.id"
        :node="node"
        :active-page-id="store.activePageId"
        :sources-by-id="sourcesById"
        @select="store.openPage($event)"
        @create="createChild"
        @remove="remove"
        @move="move"
        @reorder="reorder"
      />
      <PageTreeItem
        v-if="rootPage"
        :node="rootPage"
        :active-page-id="store.activePageId"
        :sources-by-id="sourcesById"
        @select="store.openPage($event)"
        @create="createChild"
        @remove="remove"
        @move="move"
        @reorder="reorder"
      />
    </div>

    <div class="storage-footer">
      <div class="sidebar-section-title"><span>存储源</span><button title="连接存储源" @click="storageMenuOpen = !storageMenuOpen">+</button></div>
      <button v-for="source in sources" :key="source.id" class="storage-row storage-source-button" :class="{ active: store.activeStorageSourceId === source.id }" :title="source.path" @click="store.selectStorageSource(source.id)"><span class="storage-status"></span><span>{{ source.name }}</span><small>{{ sourceLabel(source.kind) }}</small></button>
      <div v-if="storageMenuOpen" class="storage-menu">
        <button :disabled="choosingWorkspace" @click="chooseWorkspace('local')"><strong>本地目录</strong><small>选择磁盘中的知识库</small></button>
        <button :disabled="choosingWorkspace" @click="chooseWorkspace('smb')"><strong>SMB 挂载目录</strong><small>选择系统已挂载的共享目录</small></button>
      </div>
      <p>新建顶层页会保存到当前选中源；子页面继承父页面的存储源。SMB 由系统负责挂载与鉴权。</p>
    </div>
  </aside>
</template>
