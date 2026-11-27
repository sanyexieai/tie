<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PageTreeNode, StorageSource } from '@/types'
import { DEFAULT_PAGE_ICON } from '@/constants/page'
import { isEncryptedMarkdown } from '@/services/encrypted-markdown'
import { pageSourceIds, sourceShortLabel } from '@/services/page-sources'
import { useWorkspaceStore } from '@/stores/workspace'
import { useBackendStore } from '@/stores/backend'
import { pageTreeDragKey } from '@/composables/pageTreeDrag'
import { mobilePageSwipeKey } from '@/composables/mobilePageSwipe'
const props = defineProps<{
  node: PageTreeNode
  activePageId: string | null
  sourcesById: Record<string, StorageSource>
  depth?: number
  touchReorder?: boolean
  compact?: boolean
}>()
const emit = defineEmits<{
  select: [id: string]
  create: [parentId: string]
  duplicate: [id: string]
  rename: [id: string]
  remove: [id: string]
  move: [pageId: string, parentId: string]
  reorder: [pageId: string, targetId: string, position: 'before' | 'after']
}>()
const store = useWorkspaceStore()
const backend = useBackendStore()
const dragCtx = inject(pageTreeDragKey, null)
const swipeCtx = inject(mobilePageSwipeKey, null)
const usesTouchReorder = computed(() => props.touchReorder || Boolean(dragCtx))
const expanded = computed(() => !store.collapsedPageIds.includes(props.node.id))
const hasChildren = computed(() => props.node.children.length > 0)
const livePage = computed(() => store.pages.find((page) => page.id === props.node.id) ?? props.node)
const temporary = computed(() => Boolean(props.sourcesById[livePage.value.storageSourceId]?.temporary))
const boundSourceIds = computed(() => {
  const known = new Set(store.allSources.map((source) => source.id))
  return pageSourceIds(livePage.value).filter((id) => known.has(id))
})
const homeWorkspace = computed(() => {
  const workspaces = store.allSources.filter((source) => source.kind === 'local' || source.kind === 'smb')
  if (workspaces.length < 2) return null
  return workspaces.find((source) => source.id === livePage.value.storageSourceId)
    ?? workspaces.find((source) => boundSourceIds.value.includes(source.id))
    ?? null
})
const hasSyncConflict = computed(() => store.syncConflicts.has(props.node.id))
const backendSync = computed(() => {
  void backend.connected
  return store.pageBackendSync(props.node.id)
})
const backendSyncTitle = computed(() => {
  if (backendSync.value === 'synced') return '已同步到后台'
  if (backendSync.value === 'pending') return '还没同步到后台'
  if (backendSync.value === 'conflict') return '两边都改过，较新的一份在正文里'
  return ''
})
const dropPosition = ref<'before' | 'inside' | 'after' | null>(null)
const effectiveDropPosition = computed(() => {
  if (!dragCtx || dragCtx.dropTargetId.value !== props.node.id) return dropPosition.value
  return dragCtx.dropPosition.value
})
const isDragging = computed(() => (
  dragCtx?.draggingPageId.value === props.node.id
  || draggingSelf.value
))
const draggingSelf = ref(false)
const actionsOpen = ref(false)
const actionsRoot = ref<HTMLElement | null>(null)
const moreButton = ref<HTMLElement | null>(null)
const actionMenu = ref<HTMLElement | null>(null)
const menuStyle = ref<Record<string, string>>({})
const swipeActionsRef = ref<HTMLElement | null>(null)
const swipeOffset = ref(0)
const swipeActionsWidth = ref(220)
let swipePointerId: number | null = null
let swipeStartX = 0
let swipeStartY = 0
let swipeStartOffset = 0
let swipeTracking = false
let swipeGesture = false
let suppressRowClick = false

function startDrag(event: DragEvent) {
  if (usesTouchReorder.value || temporary.value) { event.preventDefault(); return }
  event.dataTransfer?.setData('text/plain', props.node.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  draggingSelf.value = true
}

function endDrag() {
  draggingSelf.value = false
  dropPosition.value = null
}

function onDragHandlePointerDown(event: PointerEvent) {
  if (!dragCtx) return
  closeSwipe()
  dragCtx.startPointerDrag(event, props.node.id)
}

function updateDropPosition(event: DragEvent) {
  if (temporary.value) return
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const relativeY = (event.clientY - bounds.top) / bounds.height
  dropPosition.value = relativeY < .27 ? 'before' : relativeY > .73 ? 'after' : 'inside'
}

function dropOnPage(event: DragEvent) {
  if (temporary.value) return
  const pageId = event.dataTransfer?.getData('text/plain')
  const position = dropPosition.value
  dropPosition.value = null
  if (!pageId || pageId === props.node.id || !position) return
  if (position === 'inside') emit('move', pageId, props.node.id)
  else emit('reorder', pageId, props.node.id, position)
}

function closeSwipe() {
  swipeOffset.value = 0
}

function snapSwipe(open: boolean) {
  const width = swipeActionsWidth.value
  swipeOffset.value = open ? -width : 0
  if (props.compact && swipeCtx) {
    swipeCtx.setOpen(open ? props.node.id : null)
  }
}

function onSwipePointerDown(event: PointerEvent) {
  if (!props.compact || event.button !== 0) return
  if (dragCtx?.draggingPageId.value) return
  const target = event.target
  if (target instanceof Element && target.closest('.tree-drag-handle, .disclosure, .tree-row-swipe-actions, .tree-actions')) return
  swipePointerId = event.pointerId
  swipeStartX = event.clientX
  swipeStartY = event.clientY
  swipeStartOffset = swipeOffset.value
  swipeTracking = true
  swipeGesture = false
  suppressRowClick = false
}

function onSwipePointerMove(event: PointerEvent) {
  if (!swipeTracking || swipePointerId !== event.pointerId) return
  const dx = event.clientX - swipeStartX
  const dy = event.clientY - swipeStartY
  if (!swipeGesture && Math.abs(dx) < 8 && Math.abs(dy) < 8) return
  if (!swipeGesture && Math.abs(dy) > Math.abs(dx) * 1.1) {
    swipeTracking = false
    return
  }
  swipeGesture = true
  suppressRowClick = true
  event.preventDefault()
  const width = swipeActionsWidth.value
  swipeOffset.value = Math.min(0, Math.max(-width, swipeStartOffset + dx))
}

function onSwipePointerUp(event: PointerEvent) {
  if (!swipeTracking || swipePointerId !== event.pointerId) return
  swipeTracking = false
  swipePointerId = null
  if (!swipeGesture) return
  const width = swipeActionsWidth.value
  const open = swipeOffset.value <= -width * 0.32
  snapSwipe(open)
}

function onRowClick() {
  if (suppressRowClick) {
    suppressRowClick = false
    return
  }
  if (props.compact && swipeOffset.value < 0) {
    closeSwipe()
    swipeCtx?.setOpen(null)
    return
  }
  selectPage()
}

function selectPage() {
  actionsOpen.value = false
  emit('select', props.node.id)
}

function onSwipeAction(action: 'create' | 'rename' | 'duplicate' | 'remove') {
  closeSwipe()
  swipeCtx?.setOpen(null)
  suppressRowClick = true
  if (action === 'create') emit('create', props.node.id)
  else if (action === 'rename') emit('rename', props.node.id)
  else if (action === 'duplicate') emit('duplicate', props.node.id)
  else emit('remove', props.node.id)
}

function toggleExpanded() { store.togglePageCollapsed(props.node.id) }

function moveTreeFocus(event: KeyboardEvent, targetIndex: number) {
  const current = event.currentTarget
  if (!(current instanceof HTMLElement)) return
  const items = [...document.querySelectorAll<HTMLElement>('.page-tree [role="treeitem"]')]
  if (!items.length) return
  const index = items.indexOf(current)
  const next = targetIndex === Infinity ? items.at(-1) : items[Math.max(0, Math.min(targetIndex, items.length - 1))]
  if (index === -1 || !next) return
  event.preventDefault()
  next.focus()
}

function onTreeKeydown(event: KeyboardEvent) {
  const current = event.currentTarget
  const items = [...document.querySelectorAll<HTMLElement>('.page-tree [role="treeitem"]')]
  const index = current instanceof HTMLElement ? items.indexOf(current) : -1
  if (event.key === 'ArrowDown') {
    moveTreeFocus(event, index + 1)
    return
  }
  if (event.key === 'ArrowUp') {
    moveTreeFocus(event, index - 1)
    return
  }
  if (event.key === 'Home') {
    moveTreeFocus(event, 0)
    return
  }
  if (event.key === 'End') {
    moveTreeFocus(event, Infinity)
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    onRowClick()
    return
  }
  if (event.key === 'ArrowRight' && hasChildren.value && !expanded.value) {
    event.preventDefault()
    toggleExpanded()
    return
  }
  if (event.key === 'ArrowLeft' && hasChildren.value && expanded.value) {
    event.preventDefault()
    toggleExpanded()
  }
}

function positionActionMenu() {
  const button = moreButton.value
  if (!button) return
  const rect = button.getBoundingClientRect()
  const menuWidth = 168
  const pad = 8
  const left = Math.min(
    Math.max(pad, rect.right - menuWidth),
    window.innerWidth - menuWidth - pad,
  )
  const spaceBelow = window.innerHeight - rect.bottom - pad
  const preferUp = spaceBelow < 220 && rect.top > spaceBelow
  menuStyle.value = preferUp
    ? {
        left: `${left}px`,
        bottom: `${window.innerHeight - rect.top + 4}px`,
        top: 'auto',
        maxHeight: `${Math.max(160, rect.top - pad * 2)}px`,
      }
    : {
        left: `${left}px`,
        top: `${rect.bottom + 4}px`,
        bottom: 'auto',
        maxHeight: `${Math.max(160, spaceBelow)}px`,
      }
}

function toggleActions() {
  actionsOpen.value = !actionsOpen.value
  if (actionsOpen.value) {
    void nextTick(() => positionActionMenu())
  }
}

function openContextActions(event: MouseEvent) {
  event.preventDefault()
  actionsOpen.value = true
  void nextTick(() => positionActionMenu())
}

async function convertPageProtection() {
  actionsOpen.value = false
  if (!await store.openPage(props.node.id)) return
  await nextTick()
  const target = store.activePage
  if (!target || target.id !== props.node.id) return
  window.dispatchEvent(new CustomEvent('tie:convert-page-protection', { detail: { pageId: target.id, sourceId: target.storageSourceId } }))
}

function closeActionsOnOutside(event: MouseEvent) {
  const target = event.target
  if (!(actionsOpen.value && target instanceof Node)) return
  if (actionsRoot.value?.contains(target) || actionMenu.value?.contains(target)) return
  actionsOpen.value = false
}

function onWindowReposition() {
  if (actionsOpen.value) positionActionMenu()
}

function measureSwipeActions() {
  if (!props.compact || !swipeActionsRef.value) return
  swipeActionsWidth.value = swipeActionsRef.value.offsetWidth || 220
}

watch(() => dragCtx?.draggingPageId.value, (id) => {
  if (id) closeSwipe()
})

watch(() => swipeCtx?.openPageId.value, (id) => {
  if (props.compact && id !== props.node.id) closeSwipe()
})

onMounted(() => {
  document.addEventListener('click', closeActionsOnOutside)
  window.addEventListener('resize', onWindowReposition)
  window.addEventListener('scroll', onWindowReposition, true)
  measureSwipeActions()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', closeActionsOnOutside)
  window.removeEventListener('resize', onWindowReposition)
  window.removeEventListener('scroll', onWindowReposition, true)
  if (swipeCtx?.openPageId.value === props.node.id) swipeCtx.setOpen(null)
})
</script>

<template>
  <div class="tree-node">
    <div :class="compact ? 'tree-row-shell' : 'tree-row-wrapper'">
      <div
        v-if="compact"
        ref="swipeActionsRef"
        class="tree-row-swipe-actions"
        role="group"
        aria-label="页面操作"
      >
        <button v-if="!temporary" type="button" class="swipe-action" @click.stop="onSwipeAction('create')">子页</button>
        <button type="button" class="swipe-action" @click.stop="onSwipeAction('rename')">重命名</button>
        <button v-if="!temporary" type="button" class="swipe-action" @click.stop="onSwipeAction('duplicate')">复制</button>
        <button type="button" class="swipe-action danger" @click.stop="onSwipeAction('remove')">{{ temporary ? '关闭工作区' : '删除' }}</button>
      </div>
      <div
        class="tree-row"
        :class="{
          'tree-row-face': compact,
          active: node.id === activePageId,
          dragging: isDragging,
          'drag-over': effectiveDropPosition === 'inside',
          'drop-before': effectiveDropPosition === 'before',
          'drop-after': effectiveDropPosition === 'after',
          'swipe-open': compact && swipeOffset < 0,
        }"
        :style="{
          paddingLeft: `${12 + (depth ?? 0) * 16}px`,
          transform: compact ? `translateX(${swipeOffset}px)` : undefined,
        }"
        :draggable="!usesTouchReorder && !temporary"
        :data-page-tree-id="node.id"
        role="treeitem"
        :aria-level="(depth ?? 0) + 1"
        :aria-expanded="hasChildren ? expanded : undefined"
        tabindex="0"
        @click="onRowClick"
        @contextmenu="openContextActions"
        @keydown="onTreeKeydown"
        @pointerdown="onSwipePointerDown"
        @pointermove="onSwipePointerMove"
        @pointerup="onSwipePointerUp"
        @pointercancel="onSwipePointerUp"
        @dragstart="startDrag"
        @dragend="endDrag"
        @dragenter.prevent="updateDropPosition"
        @dragover.prevent="updateDropPosition"
        @dragleave="dropPosition = null"
        @drop.prevent="dropOnPage"
      >
        <button
          v-if="usesTouchReorder && !temporary"
          type="button"
          class="tree-drag-handle"
          aria-label="拖动调整层级"
          @pointerdown="onDragHandlePointerDown"
          @click.stop
        >◇</button>
        <button class="disclosure" :class="{ invisible: !hasChildren }" @click.stop="toggleExpanded" :aria-label="expanded ? '收起子页面' : '展开子页面'">
          {{ expanded ? '▾' : '▸' }}
        </button>
        <span class="page-glyph" :title="isEncryptedMarkdown(node.markdown) ? '加密 Markdown' : undefined">{{ isEncryptedMarkdown(node.markdown) ? '🔒' : DEFAULT_PAGE_ICON }}</span>
        <span class="tree-title">{{ node.title || '无标题' }}</span>
        <span
          v-if="backendSync"
          class="page-sync-state"
          :class="backendSync"
          role="img"
          :title="backendSyncTitle"
          :aria-label="backendSyncTitle"
        ></span>
        <span v-if="hasSyncConflict && !backendSync" class="page-sync-conflict-badge" title="同步冲突，打开页面后可查看差异">!</span>
        <span v-if="homeWorkspace" class="page-source-badge" :title="homeWorkspace.path">{{ sourceShortLabel(homeWorkspace.name) }}</span>
        <span ref="actionsRoot" class="tree-actions" :class="{ open: actionsOpen, 'compact-actions': compact }" @click.stop>
          <button ref="moreButton" class="tree-more-button" :aria-expanded="actionsOpen" aria-haspopup="menu" aria-label="页面操作" @click="toggleActions">⋯</button>
          <Teleport to="body">
            <div
              v-if="actionsOpen"
              ref="actionMenu"
              class="tree-action-menu tree-action-menu-portal"
              role="menu"
              :style="menuStyle"
              @click.stop
            >
              <button v-if="!temporary" type="button" title="新建子页面" @click="actionsOpen = false; emit('create', node.id)">+ 新建子页面</button>
              <button type="button" title="重命名页面" @click="actionsOpen = false; emit('rename', node.id)">✎ 重命名</button>
              <button v-if="!temporary" type="button" title="复制页面" @click="actionsOpen = false; emit('duplicate', node.id)">⧉ 复制页面</button>
              <button v-if="!temporary" type="button" role="menuitem" @click="convertPageProtection">{{ isEncryptedMarkdown(livePage.markdown) ? '转为普通页面' : '转为加密页面' }}</button>
              <button type="button" class="danger" :title="temporary ? '关闭工作区' : '删除页面'" @click="actionsOpen = false; emit('remove', node.id)">× {{ temporary ? '关闭工作区' : '删除页面' }}</button>
            </div>
          </Teleport>
        </span>
      </div>
    </div>
    <div v-if="expanded && hasChildren" class="tree-children">
      <PageTreeItem
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :active-page-id="activePageId"
        :sources-by-id="sourcesById"
        :depth="(depth ?? 0) + 1"
        :touch-reorder="touchReorder"
        :compact="compact"
        @select="emit('select', $event)"
        @create="emit('create', $event)"
        @duplicate="emit('duplicate', $event)"
        @rename="emit('rename', $event)"
        @remove="emit('remove', $event)"
        @move="(pageId, parentId) => emit('move', pageId, parentId)"
        @reorder="(pageId, targetId, position) => emit('reorder', pageId, targetId, position)"
      />
    </div>
  </div>
</template>

<style scoped>
.tree-actions.compact-actions { display: flex; align-items: center; margin-right: 8px; }
</style>
