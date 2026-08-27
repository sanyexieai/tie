<script setup lang="ts">
import { computed, ref } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const tab = ref<'outline' | 'properties' | 'links' | 'graph'>('outline')
const headings = computed(() => (store.activePage?.markdown.match(/^#{1,6} .+$/gm) ?? []).map((line) => ({ level: line.indexOf(' '), text: line.replace(/^#+ /, '') })))
const outgoing = computed(() => store.activePage ? store.outgoingLinks(store.activePage.id) : [])
const incoming = computed(() => store.activePage ? store.backlinks(store.activePage.id) : [])
const graph = computed(() => {
  const current = store.activePage
  if (!current) return { nodes: [], edges: [] }
  const neighbours = [
    ...outgoing.value.map((page) => ({ page, relation: 'outgoing' as const })),
    ...incoming.value.map((page) => ({ page, relation: 'incoming' as const })),
  ].filter((item, index, all) => all.findIndex((candidate) => candidate.page.id === item.page.id) === index).slice(0, 8)
  const nodes = [
    { id: current.id, title: current.title, x: 120, y: 100, current: true },
    ...neighbours.map((item, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(neighbours.length, 1)
      return { id: item.page.id, title: item.page.title, x: 120 + Math.cos(angle) * 75, y: 100 + Math.sin(angle) * 68, current: false }
    }),
  ]
  return { nodes, edges: neighbours.map((item) => ({ from: item.relation === 'incoming' ? item.page.id : current.id, to: item.relation === 'incoming' ? current.id : item.page.id, incoming: item.relation === 'incoming' })) }
})
</script>

<template>
  <aside class="context-panel">
    <div class="context-tabs">
      <button :class="{ active: tab === 'outline' }" @click="tab = 'outline'">大纲</button>
      <button :class="{ active: tab === 'properties' }" @click="tab = 'properties'">属性</button>
      <button :class="{ active: tab === 'links' }" @click="tab = 'links'">链接</button>
      <button :class="{ active: tab === 'graph' }" @click="tab = 'graph'">图谱</button>
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
    <div v-else-if="tab === 'links'" class="context-content link-panel">
      <section>
        <p class="context-section-title">链接到</p>
        <button v-for="page in outgoing" :key="page.id" @click="store.openPage(page.id)"><span>↗</span>{{ page.title }}</button>
        <p v-if="!outgoing.length" class="muted">当前页面尚未链接到其他页面。</p>
      </section>
      <section>
        <p class="context-section-title">反向链接</p>
        <button v-for="page in incoming" :key="page.id" @click="store.openPage(page.id)"><span>↙</span>{{ page.title }}</button>
        <p v-if="!incoming.length" class="muted">还没有其他页面链接到这里。</p>
      </section>
    </div>
    <div v-else class="context-content graph-panel">
      <svg v-if="graph.nodes.length > 1" viewBox="0 0 240 200" aria-label="当前页面局部知识图谱">
        <defs>
          <marker id="graph-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
        </defs>
        <line
          v-for="edge in graph.edges"
          :key="`${edge.from}-${edge.to}`"
          :x1="graph.nodes.find((node) => node.id === edge.from)?.x"
          :y1="graph.nodes.find((node) => node.id === edge.from)?.y"
          :x2="graph.nodes.find((node) => node.id === edge.to)?.x"
          :y2="graph.nodes.find((node) => node.id === edge.to)?.y"
          :class="{ incoming: edge.incoming }"
          marker-end="url(#graph-arrow)"
        />
        <g v-for="node in graph.nodes" :key="node.id" class="graph-node" :class="{ current: node.current }" @click="store.openPage(node.id)">
          <circle :cx="node.x" :cy="node.y" :r="node.current ? 18 : 13" />
          <text :x="node.x" :y="node.y + (node.current ? 31 : 25)">{{ node.title.slice(0, 8) }}</text>
        </g>
      </svg>
      <p v-else class="muted">用“链接页面”关联其他页面后，这里会呈现局部知识图谱。</p>
      <p v-if="graph.nodes.length > 1" class="graph-caption">箭头表示链接方向；点击节点可打开页面。</p>
    </div>
  </aside>
</template>
