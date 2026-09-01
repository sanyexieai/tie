<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import PageTreeItem from '@/components/PageTreeItem.vue'
import AppIcon from '@/components/AppIcon.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { supportsAgentSkills } from '@/services/platform'
import { useBackendStore } from '@/stores/backend'

const store = useWorkspaceStore()
const backend = useBackendStore()
const inboxPages = computed(() => store.tree.filter((node) => node.title === '收集箱'))
const topLevelDragOver = ref(false)
const emit = defineEmits<{ close: []; 'open-storage-settings': [] }>()
const sourcesById = computed(() => Object.fromEntries(store.allSources.map((source) => [source.id, source])))
const activePageCount = computed(() => store.pages.filter((page) => !page.deletedAt).length)
const defaultSourceName = computed(() => store.allSources.find((source) => source.id === store.defaultStorageSourceId)?.name ?? '未设置')

watch(() => backend.connected, (connected) => {
  if (connected) void backend.refreshWorkspaces()
}, { immediate: true })

watch(() => backend.workspaces.map((workspace) => workspace.id).join('\n'), () => {
  if (backend.connected && store.initialized) void store.reloadWorkspace()
})

watch(() => store.initialized, (ready) => {
  if (ready && supportsAgentSkills.value && '__TAURI_INTERNALS__' in window) void store.refreshSkills()
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
async function renameWorkspace() {
  const name = window.prompt('工作区名称', store.workspace?.name ?? '我的知识库')
  if (name === null || name.trim() === store.workspace?.name) return
  await store.renameWorkspace(name)
}
function openFirstInbox() {
  const inbox = inboxPages.value[0]
  if (inbox) store.openPage(inbox.id)
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
      <button :class="{ selected: !store.showingTrash && inboxPages.some((page) => page.id === store.activePageId) }" @click="openFirstInbox"><span>⌑</span> 收集箱</button>
      <button :class="{ selected: store.showingRecent }" @click="store.openRecent()"><span>◷</span> 最近打开</button>
      <button :class="{ selected: store.showingFavorites }" @click="store.openFavorites()"><span>☆</span> 收藏</button>
      <button :class="{ selected: store.showingSearch }" @click="store.openSearch()"><span>⌕</span> 搜索</button>
      <button :class="{ selected: store.showingTags }" @click="store.openTags()"><span>#</span> 标签</button>
      <button :class="{ selected: store.showingGraph }" @click="store.openGraph()"><span>◌</span> 图谱</button>
      <button :class="{ selected: store.showingTrash }" @click="store.openTrash()"><span>⌫</span> 回收站</button>
    </nav>

    <div class="sidebar-section-title">
      <span>我的页面</span>
      <small class="sidebar-page-count">{{ activePageCount }} 页</small>
      <div class="sidebar-section-actions">
        <button
          type="button"
          title="同步并载入全部存储源"
          aria-label="同步并载入全部存储源"
          :disabled="store.reloading"
          @click="reloadPages"
        >{{ store.reloading ? '…' : '↻' }}</button>
        <button type="button" title="新建顶层页面" aria-label="新建顶层页面" @click="createTopLevel">+</button>
      </div>
    </div>
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
        v-for="node in store.tree"
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

    <button class="sidebar-storage-trigger" type="button" title="打开设置：外观、存储源与优先级" @click="emit('open-storage-settings')">
      <span>⚙ 设置<span v-if="store.syncConflictsCount > 0" class="sidebar-sync-conflicts">{{ store.syncConflictsCount }}</span></span>
      <small>{{ store.syncConflictsCount > 0 ? `${store.syncConflictsCount} 个同步冲突 · ` : '' }}默认 · {{ defaultSourceName }}</small>
    </button>
  </aside>
</template>
