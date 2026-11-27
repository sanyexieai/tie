<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import PageTreeItem from '@/components/PageTreeItem.vue'
import AppIcon from '@/components/AppIcon.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { supportsAgentSkills } from '@/services/platform'
import { useBackendStore } from '@/stores/backend'

const store = useWorkspaceStore()
const backend = useBackendStore()
const topLevelDragOver = ref(false)
const deleteError = ref('')
const emit = defineEmits<{ close: []; 'open-storage-settings': [] }>()
const sourcesById = computed(() => Object.fromEntries(store.allSources.map((source) => [source.id, source])))
const temporaryWorkspaces = computed(() => store.allSources.filter((source) => source.temporary).map((source) => ({
  source,
  nodes: store.tree.filter((node) => node.storageSourceId === source.id),
})))
const permanentTree = computed(() => store.tree.filter((node) => !sourcesById.value[node.storageSourceId]?.temporary))
const activePageCount = computed(() => store.pages.filter((page) => !page.deletedAt).length)
const trashCount = computed(() => store.trashedPages.length)
const defaultSourceName = computed(() => store.allSources.find((source) => source.id === store.defaultStorageSourceId)?.name ?? '未设置')
const connectionLabel = computed(() => backend.connected ? '本地 + 服务器' : '本地')
const syncDetail = computed(() => {
  if (!backend.connected) return defaultSourceName.value
  if (store.backendSyncRunning) {
    const progress = store.backendSyncProgress
    if (!progress) return '正在同步…'
    if (progress.stage === 'connecting') return '连接服务器…'
    const labels = { pages: '校对文档', assets: '检查附件', files: '同步文件', reviews: '同步批注' }
    const unit = progress.stage === 'assets' || progress.stage === 'reviews' ? ' 页' : ''
    return `${labels[progress.stage]} ${progress.completed}/${progress.total}${unit}`
  }
  if (store.backendSyncMode === 'error') return '同步失败'
  if (store.syncConflictsCount) return `${store.syncConflictsCount} 个同步冲突`
  return defaultSourceName.value
})
const connectionTitle = computed(() => {
  const details = ['打开设置：工作区与服务器', `${connectionLabel.value} · ${syncDetail.value}`]
  if (!backend.connected) return details.join('\n')
  const progress = store.backendSyncProgress
  const source = progress && store.allSources.find((item) => item.id === progress.sourceId)
  if (source) details.push(`工作区：${source.name}`)
  if (store.backendSyncMode === 'error' && backend.error) details.push(backend.error)
  if (store.backendSyncLastCompletedAt) details.push(`最近同步：${new Date(store.backendSyncLastCompletedAt).toLocaleString()}`)
  return details.join('\n')
})

watch(() => backend.connected, (connected) => {
  if (connected) void backend.refreshWorkspaces()
}, { immediate: true })

watch(() => backend.workspaces.map((workspace) => workspace.id).join('\n'), () => {
  if (backend.connected && store.initialized) void store.reloadWorkspace()
})

watch(() => store.backgroundStarted, (ready) => {
  if (ready && supportsAgentSkills.value && '__TAURI_INTERNALS__' in window) {
    void store.refreshSkills().catch((error) => { console.warn('技能列表加载失败', error) })
  }
}, { immediate: true })

async function createTopLevel() { await store.createPage(null) }
async function reloadPages() {
  if (store.reloading) return
  await store.syncRemoteSources()
}
async function createChild(parentId: string) { await store.createChildPage(parentId) }
async function duplicate(pageId: string) { await store.duplicatePage(pageId) }
async function rename(pageId: string) {
  const page = store.pages.find((item) => item.id === pageId)
  if (!page) return
  const title = window.prompt('页面标题', page.title)
  if (title === null || title.trim() === page.title) return
  await store.renamePage(pageId, title)
}
async function remove(pageId: string) {
  deleteError.value = ''
  try { await store.trashPage(pageId) }
  catch (error) { deleteError.value = error instanceof Error ? error.message : '删除页面失败，请重试' }
}
async function closeTemporaryWorkspace(sourceId: string) {
  deleteError.value = ''
  try { await store.removeStorageSource(sourceId) }
  catch (error) { deleteError.value = error instanceof Error ? error.message : '关闭临时工作区失败' }
}
async function move(pageId: string, parentId: string) { await store.movePage(pageId, parentId) }
async function reorder(pageId: string, targetId: string, position: 'before' | 'after') { await store.reorderPage(pageId, targetId, position) }
async function dropAtTopLevel(event: DragEvent) {
  const pageId = event.dataTransfer?.getData('text/plain')
  topLevelDragOver.value = false
  if (pageId) await store.movePage(pageId, null)
}
async function renameWorkspace() {
  const name = window.prompt('工作区名称', store.workspace?.name ?? '我的知识库')
  if (name === null || name.trim() === store.workspace?.name) return
  await store.renameWorkspace(name)
}
</script>

<template>
  <aside class="sidebar">
    <div class="workspace-heading">
      <AppIcon class="workspace-mark" :size="21" />
      <span>{{ store.workspace?.name ?? '加载中…' }}</span>
      <button class="ghost-button" title="重命名工作区" @click="renameWorkspace">✎</button>
      <button class="mobile-sidebar-close" aria-label="关闭侧边栏" @click="emit('close')">×</button>
    </div>

    <button class="new-page-button" @click="createTopLevel"><span>+</span> 新建页面</button>

    <nav class="quick-nav" aria-label="快捷导航">
      <button :class="{ selected: store.showingRecent }" @click="store.openRecent()"><span>◷</span> 最近打开</button>
      <button :class="{ selected: store.showingFavorites }" @click="store.openFavorites()"><span>☆</span> 收藏</button>
      <button :class="{ selected: store.showingSearch }" @click="store.openSearch()"><span>⌕</span> 搜索</button>
      <button :class="{ selected: store.showingTags }" @click="store.openTags()"><span>#</span> 标签</button>
      <button :class="{ selected: store.showingGraph }" @click="store.openGraph()"><span>◌</span> 图谱</button>
      <button :class="{ selected: store.showingTrash }" @click="store.openTrash()"><span>⌫</span> 回收站<span v-if="trashCount" class="sidebar-trash-count">{{ trashCount }}</span></button>
    </nav>
    <p v-if="store.trashNotice" class="sidebar-trash-toast" role="status">
      {{ store.trashNotice }}
      <button type="button" @click="store.openTrash()">查看</button>
      <button type="button" class="ghost" @click="store.dismissTrashNotice()">×</button>
    </p>
    <div class="sidebar-section-title">
      <span>我的页面</span>
      <small class="sidebar-page-count">{{ activePageCount }} 页</small>
      <div class="sidebar-section-actions">
        <button
          type="button"
          title="同步并载入工作区"
          aria-label="同步并载入工作区"
          :disabled="store.reloading"
          @click="reloadPages"
        >{{ store.reloading ? '…' : '↻' }}</button>
        <button type="button" title="新建顶层页面" aria-label="新建顶层页面" @click="createTopLevel">+</button>
      </div>
    </div>
    <p v-if="deleteError" class="backend-error" role="alert">{{ deleteError }}</p>
    <div class="page-tree" role="tree" aria-label="我的页面">
      <div
        class="top-level-drop-zone"
        :class="{ visible: topLevelDragOver }"
        @dragenter.prevent="topLevelDragOver = true"
        @dragover.prevent
        @dragleave="topLevelDragOver = false"
        @drop.prevent="dropAtTopLevel"
      >拖到这里设为顶层页面</div>
      <PageTreeItem
        v-for="node in permanentTree"
        :key="node.id"
        :node="node"
        :active-page-id="store.activePageId"
        :sources-by-id="sourcesById"
        @select="store.openPage($event)"
        @create="createChild"
        @duplicate="duplicate"
        @rename="rename"
        @remove="remove"
        @move="move"
        @reorder="reorder"
      />
      <section v-for="{ source, nodes } in temporaryWorkspaces" :key="source.id" :data-temporary-source-id="source.id">
        <div class="sidebar-section-title">
          <span :title="source.path">{{ source.name }}</span>
          <small>临时工作区</small>
          <div class="sidebar-section-actions">
            <button type="button" :aria-label="`关闭临时工作区 ${source.name}`" title="关闭临时工作区（保留原文件）" @click="closeTemporaryWorkspace(source.id)">×</button>
          </div>
        </div>
        <PageTreeItem
          v-for="node in nodes"
          :key="node.id"
          :node="node"
          :active-page-id="store.activePageId"
          :sources-by-id="sourcesById"
          @select="store.openPage($event)"
          @rename="rename"
          @remove="closeTemporaryWorkspace(source.id)"
        />
      </section>
    </div>


    <div v-if="supportsAgentSkills" class="sidebar-section-title skills-section-title">
      <button
        type="button"
        class="skills-section-toggle"
        :aria-expanded="!store.skillsSectionCollapsed"
        :title="store.skillsSectionCollapsed ? '展开 Agent Skills' : '收起 Agent Skills'"
        @click="store.toggleSkillsSectionCollapsed()"
      >
        <span class="skills-section-chevron" aria-hidden="true">{{ store.skillsSectionCollapsed ? '▸' : '▾' }}</span>
        <span>Agent Skills</span>
        <small class="sidebar-page-count">{{ store.skillConnections.length }}</small>
      </button>
      <button type="button" title="扫描并接入" @click="store.openSkillManager()">+</button>
    </div>
    <div
      v-if="supportsAgentSkills"
      v-show="!store.skillsSectionCollapsed"
      class="page-tree skills-tree"
      role="list"
      aria-label="Agent Skills"
    >
      <button
        v-for="skill in store.skillConnections"
        :key="skill.id"
        type="button"
        class="skills-tree-item"
        :class="{ selected: store.showingSkills && !store.showingSkillManager && store.activeSkillId === skill.id }"
        :title="skill.skillPath"
        @click="store.openSkills(skill.id)"
      >
        <strong>{{ skill.name }}</strong>
      </button>
      <button
        type="button"
        class="skills-tree-empty"
        @click="store.openSkillManager()"
      >
        {{ store.skillsLoading ? '载入中…' : '接入 Skill…' }}
      </button>
    </div>

    <button class="sidebar-storage-trigger" type="button" :title="connectionTitle" @click="emit('open-storage-settings')">
      <span>⚙ 设置<span v-if="store.syncConflictsCount > 0" class="sidebar-sync-conflicts">{{ store.syncConflictsCount }}</span></span>
      <small>{{ connectionLabel }} · {{ syncDetail }}</small>
    </button>
  </aside>
</template>
