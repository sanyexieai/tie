<script setup lang="ts">
import { computed, ref } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const tab = ref<'outline' | 'properties' | 'links'>('outline')
const headings = computed(() => (store.activePage?.markdown.match(/^#{1,6} .+$/gm) ?? []).map((line) => ({ level: line.indexOf(' '), text: line.replace(/^#+ /, '') })))
</script>

<template>
  <aside class="context-panel">
    <div class="context-tabs">
      <button :class="{ active: tab === 'outline' }" @click="tab = 'outline'">大纲</button>
      <button :class="{ active: tab === 'properties' }" @click="tab = 'properties'">属性</button>
      <button :class="{ active: tab === 'links' }" @click="tab = 'links'">链接</button>
    </div>
    <div v-if="tab === 'outline'" class="context-content outline-list">
      <p v-if="!headings.length" class="muted">添加标题后将在这里生成大纲。</p>
      <button v-for="heading in headings" :key="heading.text" :style="{ paddingLeft: `${(heading.level - 1) * 10}px` }">{{ heading.text }}</button>
    </div>
    <div v-else-if="tab === 'properties'" class="context-content property-list">
      <div><span>存储源</span><strong>本地工作区</strong></div>
      <div><span>创建时间</span><strong>{{ store.activePage?.createdAt.slice(0, 10) }}</strong></div>
      <div><span>更新时间</span><strong>{{ store.activePage?.updatedAt.slice(0, 10) }}</strong></div>
      <div><span>页面 ID</span><code>{{ store.activePage?.id }}</code></div>
    </div>
    <div v-else class="context-content"><p class="muted">反向链接与知识图谱将在下一迭代启用。</p></div>
  </aside>
</template>
