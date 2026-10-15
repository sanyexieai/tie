<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { renderMermaid } from '@/services/mermaid'

const props = defineProps(nodeViewProps)
const isMermaid = computed(() => String(props.node.attrs.language ?? '').toLowerCase() === 'mermaid')
const svg = ref('')
const message = ref('')

watch([isMermaid, () => props.node.textContent], ([enabled, source], _, onCleanup) => {
  let cancelled = false
  svg.value = ''
  message.value = ''
  const timer = setTimeout(async () => {
    if (!enabled) return
    if (!source.trim() || /^(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\s*;?\s*$/i.test(source.trim())) {
      message.value = '添加节点和连线后显示流程图，例如：A[开始] --> B[结束]'
      return
    }
    message.value = '正在渲染图表…'
    try {
      const result = await renderMermaid(source)
      if (cancelled) return
      svg.value = result
      message.value = ''
    } catch {
      if (!cancelled) message.value = '图表无法渲染，请检查 Mermaid 语法。源码仍可编辑。'
    }
  }, 250)
  onCleanup(() => {
    cancelled = true
    clearTimeout(timer)
  })
}, { immediate: true })
</script>

<template>
  <NodeViewWrapper :class="{ 'mermaid-block': isMermaid }">
    <div v-if="isMermaid" class="mermaid-preview" contenteditable="false" aria-label="Mermaid 图表预览">
      <div v-if="svg" class="mermaid-diagram" v-html="svg" />
      <p v-else role="status">{{ message || '正在渲染图表…' }}</p>
    </div>
    <pre><NodeViewContent as="code" :class="node.attrs.language ? `language-${node.attrs.language}` : undefined" /></pre>
  </NodeViewWrapper>
</template>

<style scoped>
.mermaid-preview { overflow-x: auto; padding: 16px; border: 1px solid var(--border); border-radius: 9px; background: #fff; color: #292823; }
.mermaid-preview p { margin: 0; font-size: 13px; }
.mermaid-diagram :deep(svg) { display: block; max-width: 100%; height: auto; margin: auto; }
.mermaid-block { margin: 1.2em 0; }
.mermaid-block pre { margin-top: 8px; }
</style>
