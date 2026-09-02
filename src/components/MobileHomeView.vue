<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import PageTreeItem from '@/components/PageTreeItem.vue'
import { pageTreeDragKey } from '@/composables/pageTreeDrag'
import { mobilePageSwipeKey } from '@/composables/mobilePageSwipe'
import { usePageTreePointerDrag } from '@/composables/usePageTreePointerDrag'
import { pageBoundToSource, pageSourceIds, pageSourceRoleLabel, sourceShortLabel } from '@/services/page-sources'
import { isCloudStorageSourceId } from '@/services/storage-identity'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const emit = defineEmits<{ 'open-settings': [] }>()

const creating = ref(false)
const createError = ref('')
const treeRoot = ref<HTMLElement | null>(null)
const openSwipePageId = ref<string | null>(null)
const renamePageId = ref<string | null>(null)
const renameDraft = ref('')
const bindPageId = ref<string | null>(null)
const bindBusy = ref(false)
const bindError = ref('')

function onMobileBack(event: Event) {
  const detail = (event as CustomEvent<{ handled?: boolean }>).detail
  if (!detail || detail.handled) return
  if (renamePageId.value) {
    renamePageId.value = null
    detail.handled = true
    return
  }
  if (bindPageId.value) {
    bindPageId.value = null
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

const bindPage = computed(() => store.pages.find((page) => page.id === bindPageId.value) ?? null)
const bindSourceChoices = computed(() => {
  if (!bindPage.value) return []
  return store.allSources.filter((source) => store.canBindPageTo(source.id, bindPage.value!) || pageBoundToSource(bindPage.value!, source.id))
})
const bindSourceIds = computed(() => {
  if (!bindPage.value) return []
  const known = new Set(store.allSources.map((source) => source.id))
  return pageSourceIds(bindPage.value).filter((id) => known.has(id))
})
const bindCloudSourceIds = computed(() => bindSourceIds.value.filter((id) => isCloudStorageSourceId(id)))

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

function openBind(pageId: string) {
  bindPageId.value = pageId
  bindError.value = ''
}

async function toggleBindSource(targetSourceId: string) {
  if (!bindPage.value || bindBusy.value) return
  const page = bindPage.value
  const bound = pageBoundToSource(page, targetSourceId)
  bindBusy.value = true
  bindError.value = ''
  try {
    if (bound) {
      if (pageSourceIds(page).length <= 1) return
      await store.unbindPageFromSource(page.id, targetSourceId, true)
    } else {
      await store.bindPageToSource(page.id, targetSourceId, true)
    }
  } catch (error) {
    bindError.value = error instanceof Error ? error.message : '无法更新存储源绑定'
  } finally {
    bindBusy.value = false
  }
}

async function setBindPrimary(sourceId: string) {
  if (!bindPage.value || bindBusy.value) return
  if (!isCloudStorageSourceId(sourceId)) {
    bindError.value = '协作主源只能是云端存储（S3 / 后台）'
    return
  }
  bindBusy.value = true
  bindError.value = ''
  try {
    await store.setPagePrimarySource(bindPage.value.id, sourceId)
  } catch (error) {
    bindError.value = error instanceof Error ? error.message : '无法设置协作主源'
  } finally {
    bindBusy.value = false
  }
}

async function pushBindMirrors() {
  if (!bindPage.value || bindBusy.value || bindSourceIds.value.length <= 1) return
  bindBusy.value = true
  bindError.value = ''
  try {
    await store.pushPageToMirrors(bindPage.value.id)
  } catch (error) {
    bindError.value = error instanceof Error ? error.message : '同步到备份源失败'
  } finally {
    bindBusy.value = false
  }
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
        <button type="button" title="新建页面" :disabled="creating" @click="createPage">{{ creating ? '…' : '＋' }}</button>
      </div>
    </div>

    <p class="mobile-home-tree-hint">左滑页面可编辑；按住 ◇ 拖动调整层级</p>

    <p v-if="createError" class="mobile-home-error" role="alert">
      {{ createError }}
      <button v-if="createError.includes('存储源')" type="button" class="mobile-home-error-action" @click="emit('open-settings')">去设置添加</button>
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
        @open-bind="openBind"
        @move="move"
        @reorder="reorder"
      />
      <p v-if="!store.tree.length" class="mobile-home-empty">还没有页面，点右下角 ＋ 新建，或先在设置里连接存储源。</p>
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

    <div v-if="bindPageId && bindPage" class="mobile-sheet-backdrop" @click="bindPageId = null">
      <section class="mobile-sheet mobile-bind-sheet" role="dialog" aria-modal="true" aria-label="绑定存储源" @click.stop>
        <header class="mobile-sheet-header">
          <div>
            <strong>绑定存储源</strong>
            <small>{{ bindPage.title || '无标题' }}</small>
          </div>
          <button type="button" aria-label="关闭" @click="bindPageId = null">×</button>
        </header>
        <p class="mobile-sheet-hint">协作认云端主源；本机只是备份。日常只写主源，点「同步到备份」才更新镜像。</p>
        <div class="mobile-bind-list">
          <button
            v-for="source in bindSourceChoices"
            :key="source.id"
            type="button"
            class="mobile-bind-row"
            :class="{
              bound: bindSourceIds.includes(source.id),
              primary: source.id === bindPage.storageSourceId,
              unavailable: source.available === false,
            }"
            :disabled="bindBusy || source.available === false"
            @click="toggleBindSource(source.id)"
          >
            <span class="mobile-bind-check">{{ bindSourceIds.includes(source.id) ? '✓' : '○' }}</span>
            <span class="mobile-bind-main">
              <strong>{{ sourceShortLabel(source.name) }} · {{ source.name }}</strong>
              <small>{{ source.available === false ? '当前不可访问' : source.path }}</small>
            </span>
            <span v-if="pageSourceRoleLabel(bindPage, source.id) === 'primary'" class="mobile-bind-tag">协作主源</span>
            <span v-else-if="bindSourceIds.includes(source.id)" class="mobile-bind-tag mirror">备份</span>
          </button>
          <p v-if="!bindSourceChoices.length" class="mobile-bind-empty">没有可绑定的存储源</p>
        </div>
        <div v-if="bindCloudSourceIds.length > 1 || (bindCloudSourceIds.length === 1 && bindSourceIds.length > 1)" class="mobile-bind-primary">
          <span>设为协作主源（仅云端）</span>
          <button
            v-for="sourceId in bindCloudSourceIds"
            :key="sourceId"
            type="button"
            :class="{ active: sourceId === bindPage.storageSourceId }"
            :disabled="bindBusy || sourceId === bindPage.storageSourceId"
            @click="setBindPrimary(sourceId)"
          >{{ store.allSources.find((item) => item.id === sourceId)?.name ?? sourceId }}</button>
          <button type="button" class="mobile-bind-mirror-sync" :disabled="bindBusy" @click="pushBindMirrors">同步到备份</button>
        </div>
        <p v-if="bindError" class="mobile-sheet-error" role="alert">{{ bindError }}</p>
      </section>
    </div>
  </div>
</template>
