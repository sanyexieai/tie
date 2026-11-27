<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import PageTreeItem from '@/components/PageTreeItem.vue'
import { pageTreeDragKey } from '@/composables/pageTreeDrag'
import { mobilePageSwipeKey } from '@/composables/mobilePageSwipe'
import { usePageTreePointerDrag } from '@/composables/usePageTreePointerDrag'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const emit = defineEmits<{ 'open-settings': [] }>()

const creating = ref(false)
const createError = ref('')
const treeRoot = ref<HTMLElement | null>(null)
const openSwipePageId = ref<string | null>(null)
const renamePageId = ref<string | null>(null)
const renameDraft = ref('')

function onMobileBack(event: Event) {
  const detail = (event as CustomEvent<{ handled?: boolean }>).detail
  if (!detail || detail.handled) return
  if (renamePageId.value) {
    renamePageId.value = null
    detail.handled = true
    return
  }
  if (openSwipePageId.value) {
    openSwipePageId.value = null
    detail.handled = true
  }
}

onMounted(() => {
  window.addEventListener('tie:mobile-back', onMobileBack)
})
onBeforeUnmount(() => {
  window.removeEventListener('tie:mobile-back', onMobileBack)
})

const activePageCount = computed(() => store.pages.filter((page) => !page.deletedAt).length)
const sourcesById = computed(() => Object.fromEntries(store.allSources.map((source) => [source.id, source])))

provide(mobilePageSwipeKey, {
  openPageId: openSwipePageId,
  setOpen: (pageId) => { openSwipePageId.value = pageId },
})

const {
  draggingPageId,
  dropTargetId,
  dropPosition,
  topLevelDragOver,
  startPointerDrag,
} = usePageTreePointerDrag(treeRoot, {
  onMove(pageId, targetId, position) {
    if (position === 'inside') {
      void store.movePage(pageId, targetId)
      return
    }
    void store.reorderPage(pageId, targetId, position)
  },
  onMoveTopLevel(pageId) {
    void store.movePage(pageId, null)
  },
})

provide(pageTreeDragKey, {
  draggingPageId,
  dropTargetId,
  dropPosition,
  startPointerDrag,
})

async function createPage() {
  if (creating.value) return
  creating.value = true
  createError.value = ''
  try {
    await store.createPage(null)
  } catch (error) {
    createError.value = error instanceof Error ? error.message : '无法创建页面'
  } finally {
    creating.value = false
  }
}

async function reloadPages() {
  if (store.reloading) return
  await store.syncRemoteSources()
}

async function move(pageId: string, parentId: string) {
  await store.movePage(pageId, parentId)
}

async function reorder(pageId: string, targetId: string, position: 'before' | 'after') {
  await store.reorderPage(pageId, targetId, position)
}

async function createChild(parentId: string) {
  await store.createChildPage(parentId)
}

async function duplicate(pageId: string) {
  await store.duplicatePage(pageId)
}

function openRename(pageId: string) {
  const page = store.pages.find((item) => item.id === pageId)
  if (!page) return
  renamePageId.value = pageId
  renameDraft.value = page.title
}

async function confirmRename() {
  const pageId = renamePageId.value
  if (!pageId) return
  const title = renameDraft.value.trim()
  if (!title) return
  const page = store.pages.find((item) => item.id === pageId)
  if (!page || title === page.title) {
    renamePageId.value = null
    return
  }
  await store.renamePage(pageId, title)
  renamePageId.value = null
}

async function remove(pageId: string) {
  if (store.pages.filter((page) => !page.deletedAt).length <= 1) return
  await store.trashPage(pageId)
}

</script>

<template>
  <div class="mobile-home">
    <div class="mobile-home-top">
    <header class="mobile-home-header">
      <div class="mobile-home-brand">
        <AppIcon class="mobile-home-mark" :size="28" />
        <div class="mobile-home-brand-text">
          <strong>{{ store.workspace?.name ?? '我的知识库' }}</strong>
          <small>{{ activePageCount }} 个页面</small>
        </div>
      </div>
      <div class="mobile-home-header-actions">
        <button type="button" class="mobile-home-icon-btn" title="搜索" aria-label="搜索" @click="store.openSearch()">⌕</button>
        <button type="button" class="mobile-home-icon-btn" title="设置" aria-label="设置" @click="emit('open-settings')">⚙</button>
      </div>
    </header>

    <nav class="mobile-home-nav" aria-label="快捷入口">
      <button type="button" @click="store.openRecent()">最近</button>
      <button type="button" @click="store.openFavorites()">收藏</button>
      <button type="button" @click="store.openTags()">标签</button>
      <button type="button" @click="store.openTrash()">回收站</button>
    </nav>

    <div class="mobile-home-section-head">
      <span>页面树</span>
      <div class="mobile-home-section-actions">
        <button type="button" :disabled="store.reloading" title="同步" @click="reloadPages">{{ store.reloading ? '…' : '↻' }}</button>
        <button type="button" aria-label="新建加密页面" title="新建加密 Markdown 页面" @click="store.openEncryptedPage()">🔒</button>
        <button type="button" title="新建页面" :disabled="creating" @click="createPage">{{ creating ? '…' : '＋' }}</button>
      </div>
    </div>

    <p class="mobile-home-tree-hint">左滑页面可编辑；按住 ◇ 拖动调整层级</p>

    <p v-if="createError" class="mobile-home-error" role="alert">
      {{ createError }}
      <button v-if="createError.includes('工作区')" type="button" class="mobile-home-error-action" @click="emit('open-settings')">去设置添加</button>
    </p>
    </div>

    <div class="mobile-home-scroll">
    <div
      ref="treeRoot"
      class="mobile-home-list page-tree mobile-page-tree"
      role="tree"
      aria-label="页面树"
    >
      <div
        class="top-level-drop-zone mobile-top-level-drop-zone"
        :class="{ visible: topLevelDragOver }"
      >拖到这里设为顶层页面</div>
      <PageTreeItem
        v-for="node in store.tree"
        :key="node.id"
        :node="node"
        :active-page-id="store.activePageId"
        :sources-by-id="sourcesById"
        touch-reorder
        compact
        @select="store.openPage($event)"
        @create="createChild"
        @duplicate="duplicate"
        @rename="openRename"
        @remove="remove"
        @move="move"
        @reorder="reorder"
      />
      <p v-if="!store.tree.length" class="mobile-home-empty">还没有页面。点右下角 ＋ 新建，或先在设置里添加工作区。</p>
    </div>
    </div>

    <button type="button" class="mobile-home-fab" aria-label="新建页面" :disabled="creating" @click="createPage">{{ creating ? '…' : '＋' }}</button>

    <div v-if="renamePageId" class="mobile-sheet-backdrop" @click="renamePageId = null">
      <section class="mobile-sheet" role="dialog" aria-modal="true" aria-label="重命名页面" @click.stop>
        <header class="mobile-sheet-header">
          <strong>重命名页面</strong>
          <button type="button" aria-label="关闭" @click="renamePageId = null">×</button>
        </header>
        <input
          v-model="renameDraft"
          class="mobile-sheet-input"
          type="text"
          aria-label="页面标题"
          @keydown.enter.prevent="confirmRename"
        />
        <footer class="mobile-sheet-footer">
          <button type="button" @click="renamePageId = null">取消</button>
          <button type="button" class="primary" @click="confirmRename">保存</button>
        </footer>
      </section>
    </div>
  </div>
</template>
