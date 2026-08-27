<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PageTreeNode } from '@/types'

const props = defineProps<{ node: PageTreeNode; activePageId: string | null; depth?: number }>()
const emit = defineEmits<{ select: [id: string]; create: [parentId: string]; remove: [id: string] }>()
const expanded = ref(true)
const hasChildren = computed(() => props.node.children.length > 0)
</script>

<template>
  <div class="tree-node">
    <div
      class="tree-row"
      :class="{ active: node.id === activePageId }"
      :style="{ paddingLeft: `${12 + (depth ?? 0) * 16}px` }"
      @click="emit('select', node.id)"
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
      />
    </div>
  </div>
</template>

