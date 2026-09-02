<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PageTreeNode, StorageSource } from '@/types'
import { DEFAULT_PAGE_ICON } from '@/constants/page'
import { pageBoundToSource, pageSourceIds, sourceShortLabel } from '@/services/page-sources'
import { useWorkspaceStore } from '@/stores/workspace'
import { pageTreeDragKey } from '@/composables/pageTreeDrag'
import { mobilePageSwipeKey } from '@/composables/mobilePageSwipe'
import { usesMobileUi } from '@/services/platform'

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
  'open-bind': [id: string]
  move: [pageId: string, parentId: string]
  reorder: [pageId: string, targetId: string, position: 'before' | 'after']
}>()
const store = useWorkspaceStore()
const dragCtx = inject(pageTreeDragKey, null)
const swipeCtx = inject(mobilePageSwipeKey, null)
const usesTouchReorder = computed(() => props.touchReorder || Boolean(dragCtx))
const expanded = computed(() => !store.collapsedPageIds.includes(props.node.id))
const hasChildren = computed(() => props.node.children.length > 0)
const livePage = computed(() => store.pages.find((page) => page.id === props.node.id) ?? props.node)
const boundSourceIds = computed(() => pageSourceIds(livePage.value))
const boundSources = computed(() => boundSourceIds.value
  .map((id) => props.sourcesById[id])
  .filter((item): item is StorageSource => Boolean(item)))
const sourceChoices = computed(() => store.allSources.filter((item) => store.canBindPageTo(item.id, livePage.value) || pageBoundToSource(livePage.value, item.id)))
function sourceBadgeTitle(item: StorageSource) {
  const primary = item.id === livePage.value.storageSourceId ? ' · 主源' : ' · 已绑定'
  return `${item.name}${primary}\n${item.path}`
}
const hasSyncConflict = computed(() => store.syncConflicts.has(props.node.id))
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
const bindMenuOpen = ref(false)
const bindBusy = ref(false)
const actionsRoot = ref<HTMLElement | null>(null)
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
  if (usesTouchReorder.value) return
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
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const relativeY = (event.clientY - bounds.top) / bounds.height
  dropPosition.value = relativeY < .27 ? 'before' : relativeY > .73 ? 'after' : 'inside'
}

function dropOnPage(event: DragEvent) {
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
  if (target instanceof Element && target.closest('.tree-drag-handle, .disclosure, .tree-row-swipe-actions')) return
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
  bindMenuOpen.value = false
  emit('select', props.node.id)
}

function onSwipeAction(action: 'create' | 'rename' | 'duplicate' | 'bind' | 'remove') {
  closeSwipe()
  swipeCtx?.setOpen(null)
  suppressRowClick = true
  if (action === 'create') emit('create', props.node.id)
  else if (action === 'rename') emit('rename', props.node.id)
  else if (action === 'duplicate') emit('duplicate', props.node.id)
  else if (action === 'bind') emit('open-bind', props.node.id)
  else emit('remove', props.node.id)
}

async function toggleSourceBinding(targetSourceId: string) {
  if (bindBusy.value) return
  const page = livePage.value
  const bound = pageBoundToSource(page, targetSourceId)
  bindBusy.value = true
  try {
    if (bound) {
      if (boundSourceIds.value.length <= 1) return
      const target = store.allSources.find((item) => item.id === targetSourceId)
      if (!usesMobileUi.value && !window.confirm(`取消绑定「${target?.name ?? '存储源'}」？该源上的页面副本将被删除。`)) return
      await store.unbindPageFromSource(page.id, targetSourceId, true)
    } else {
      await store.bindPageToSource(page.id, targetSourceId, true)
    }
  } catch (error) {
    if (!usesMobileUi.value) window.alert(error instanceof Error ? error.message : '无法更新存储源绑定')
  } finally {
    bindBusy.value = false
  }
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

function closeActionsOnOutside(event: MouseEvent) {
  const target = event.target
  if (actionsOpen.value && target instanceof Node && !actionsRoot.value?.contains(target)) {
    actionsOpen.value = false
    bindMenuOpen.value = false
  }
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
  measureSwipeActions()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', closeActionsOnOutside)
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
        <button type="button" class="swipe-action" @click.stop="onSwipeAction('create')">子页</button>
        <button type="button" class="swipe-action" @click.stop="onSwipeAction('rename')">重命名</button>
        <button type="button" class="swipe-action" @click.stop="onSwipeAction('duplicate')">复制</button>
        <button type="button" class="swipe-action" @click.stop="onSwipeAction('bind')">存储</button>
        <button type="button" class="swipe-action danger" @click.stop="onSwipeAction('remove')">删除</button>
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
        :draggable="!usesTouchReorder"
        :data-page-tree-id="node.id"
        role="treeitem"
        :aria-level="(depth ?? 0) + 1"
        :aria-expanded="hasChildren ? expanded : undefined"
        tabindex="0"
        @click="onRowClick"
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
          v-if="usesTouchReorder"
          type="button"
          class="tree-drag-handle"
          aria-label="拖动调整层级"
          @pointerdown="onDragHandlePointerDown"
          @click.stop
        >◇</button>
        <button class="disclosure" :class="{ invisible: !hasChildren }" @click.stop="toggleExpanded" :aria-label="expanded ? '收起子页面' : '展开子页面'">
          {{ expanded ? '▾' : '▸' }}
        </button>
        <span class="page-glyph">{{ DEFAULT_PAGE_ICON }}</span>
        <span class="tree-title">{{ node.title || '无标题' }}</span>
        <span v-if="hasSyncConflict" class="page-sync-conflict-badge" title="同步冲突，打开页面后可查看差异">!</span>
        <span v-if="boundSources.length && compact" class="page-source-badges compact">
          <span
            v-for="item in boundSources.slice(0, 2)"
            :key="item.id"
            class="page-source-badge"
            :class="[item.kind, { primary: item.id === livePage.storageSourceId }]"
            :title="sourceBadgeTitle(item)"
          >{{ sourceShortLabel(item.name) }}</span>
          <span v-if="boundSources.length > 2" class="page-source-more">+{{ boundSources.length - 2 }}</span>
        </span>
        <span v-else-if="boundSources.length" class="page-source-badges">
          <span
            v-for="item in boundSources"
            :key="item.id"
            class="page-source-badge"
            :class="[item.kind, { primary: item.id === livePage.storageSourceId }]"
            :title="sourceBadgeTitle(item)"
          >{{ sourceShortLabel(item.name) }}</span>
        </span>
        <span v-if="!compact" ref="actionsRoot" class="tree-actions" :class="{ open: actionsOpen }" @click.stop>
          <button class="tree-more-button" :aria-expanded="actionsOpen" aria-label="页面操作" @click="actionsOpen = !actionsOpen; bindMenuOpen = false">⋯</button>
          <span v-if="actionsOpen" class="tree-action-menu">
            <button title="新建子页面" @click="actionsOpen = false; emit('create', node.id)">+ 新建子页面</button>
            <button title="重命名页面" @click="actionsOpen = false; emit('rename', node.id)">✎ 重命名</button>
            <button title="复制页面" @click="actionsOpen = false; emit('duplicate', node.id)">⧉ 复制页面</button>
            <button title="绑定存储源" :class="{ active: bindMenuOpen }" @click="bindMenuOpen = !bindMenuOpen">◈ 绑定存储源</button>
            <div v-if="bindMenuOpen" class="tree-bind-menu">
              <button
                v-for="item in sourceChoices"
                :key="item.id"
                :class="{ bound: boundSourceIds.includes(item.id), primary: item.id === livePage.storageSourceId }"
                :disabled="bindBusy || item.available === false"
                :title="item.available === false ? '当前不可访问' : item.path"
                @click="toggleSourceBinding(item.id)"
              >
                <span>{{ boundSourceIds.includes(item.id) ? '✓' : '○' }} {{ sourceShortLabel(item.name) }} {{ item.name }}</span>
                <small>{{ item.id === livePage.storageSourceId ? '主源' : boundSourceIds.includes(item.id) ? '已绑定' : '未绑定' }}</small>
              </button>
              <p v-if="!sourceChoices.length" class="tree-bind-empty">没有可绑定的存储源</p>
            </div>
            <button class="danger" title="删除页面" @click="actionsOpen = false; emit('remove', node.id)">× 删除页面</button>
          </span>
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
        @open-bind="emit('open-bind', $event)"
        @move="(pageId, parentId) => emit('move', pageId, parentId)"
        @reorder="(pageId, targetId, position) => emit('reorder', pageId, targetId, position)"
      />
    </div>
  </div>
</template>
