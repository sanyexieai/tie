<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PageTreeNode } from '@/types'

const props = defineProps<{ node: PageTreeNode; activePageId: string | null; depth?: number }>()
const emit = defineEmits<{
  select: [id: string]
  create: [parentId: string]
  remove: [id: string]
  move: [pageId: string, parentId: string]
  reorder: [pageId: string, targetId: string, position: 'before' | 'after']
}>()
const expanded = ref(true)
const hasChildren = computed(() => props.node.children.length > 0)
const dropPosition = ref<'before' | 'inside' | 'after' | null>(null)

function startDrag(event: DragEvent) {
  event.dataTransfer?.setData('text/plain', props.node.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
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
</script>

<template>
  <div class="tree-node">
    <div
      class="tree-row"
      :class="{ active: node.id === activePageId, 'drag-over': dropPosition === 'inside', 'drop-before': dropPosition === 'before', 'drop-after': dropPosition === 'after' }"
      :style="{ paddingLeft: `${12 + (depth ?? 0) * 16}px` }"
      :draggable="true"
      @click="emit('select', node.id)"
      @dragstart="startDrag"
      @dragenter.prevent="updateDropPosition"
      @dragover.prevent="updateDropPosition"
      @dragleave="dropPosition = null"
      @drop.prevent="dropOnPage"
    >
      <button class="disclosure" :class="{ invisible: !hasChildren }" @click.stop="expanded = !expanded" :aria-label="expanded ? '收起子页面' : '展开子页面'">
        {{ expanded ? '⌄' : '›' }}
      </button>
      <span class="page-glyph">▱</span>
      <span class="tree-title">{{ node.title || '无标题' }}</span>
      <span class="tree-actions" @click.stop>
        <button title="新建子页面" @click="emit('create', node.id)">+</button>
        <button title="删除页面" @click="emit('remove', node.id)">×</button>
      </span>
    </div>
    <div v-if="expanded && hasChildren" class="tree-children">
      <PageTreeItem
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :active-page-id="activePageId"
        :depth="(depth ?? 0) + 1"
        @select="emit('select', $event)"
        @create="emit('create', $event)"
        @remove="emit('remove', $event)"
        @move="(pageId, parentId) => emit('move', pageId, parentId)"
        @reorder="(pageId, targetId, position) => emit('reorder', pageId, targetId, position)"
      />
    </div>
  </div>
</template>
