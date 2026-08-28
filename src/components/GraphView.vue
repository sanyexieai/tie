<script setup lang="ts">
import { computed, ref } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { StorageKind } from '@/types'

type NodeKind = 'title' | 'tag' | 'content'
interface GraphNode { id: string; label: string; kind: NodeKind; x: number; y: number; pageId?: string; tag?: string; sourceKind?: StorageKind }
interface GraphEdge { from: string; to: string; kind: 'link' | 'tag' | 'content'; crossSource?: boolean }

const store = useWorkspaceStore()
const filter = ref('')
const sourceFilter = ref<string | null>(null)
const graph = computed(() => {
  const query = filter.value.trim().toLocaleLowerCase()
  const pages = store.pages.filter((page) => !page.deletedAt && (!sourceFilter.value || page.storageSourceId === sourceFilter.value) && (!query || `${page.title} ${page.tags.join(' ')}`.toLocaleLowerCase().includes(query))).slice(0, 60)
  const pageIds = new Set(pages.map((page) => page.id))
  const pageById = new Map(store.pages.map((page) => [page.id, page]))
  const tagNames = [...new Set(pages.flatMap((page) => page.tags))].slice(0, 35)
  const concepts = pages.flatMap((page) => (page.markdown.match(/^#{2,6} (.+)$/gm) ?? []).slice(0, 2).map((heading, index) => ({ id: `content:${page.id}:${index}`, label: heading.replace(/^#+ /, ''), pageId: page.id }))).slice(0, 45)
  const placeRing = <T extends { id: string }>(items: T[], radiusX: number, radiusY: number, offset = -Math.PI / 2) => items.map((item, index) => {
    const angle = offset + (index * Math.PI * 2) / Math.max(items.length, 1)
    return { ...item, x: 500 + Math.cos(angle) * radiusX, y: 340 + Math.sin(angle) * radiusY }
  })
  const titleNodes: GraphNode[] = placeRing(pages.map((page) => ({ id: page.id, label: page.title, kind: 'title' as const, pageId: page.id, sourceKind: store.workspace?.sources.find((source) => source.id === page.storageSourceId)?.kind ?? 'local' })), 360, 250)
  const tagNodes: GraphNode[] = placeRing(tagNames.map((tag) => ({ id: `tag:${tag}`, label: `# ${tag}`, kind: 'tag' as const, tag })), 190, 125, 0)
  const contentNodes: GraphNode[] = placeRing(concepts.map((concept) => ({ ...concept, kind: 'content' as const })), 78, 54)
  const nodes = [...titleNodes, ...tagNodes, ...contentNodes]
  const edges: GraphEdge[] = [
    ...store.links.filter((link) => pageIds.has(link.fromPageId) && pageIds.has(link.toPageId)).map((link) => ({ from: link.fromPageId, to: link.toPageId, kind: 'link' as const, crossSource: pageById.get(link.fromPageId)?.storageSourceId !== pageById.get(link.toPageId)?.storageSourceId })),
    ...pages.flatMap((page) => page.tags.filter((tag) => tagNames.includes(tag)).map((tag) => ({ from: page.id, to: `tag:${tag}`, kind: 'tag' as const }))),
    ...contentNodes.map((concept) => ({ from: concept.pageId!, to: concept.id, kind: 'content' as const })),
  ]
  return { nodes, edges }
})

function selectNode(node: GraphNode) {
  if (node.kind === 'title' && node.pageId) store.openPage(node.pageId)
  if (node.kind === 'tag' && node.tag) store.openTags(node.tag)
}
</script>

<template>
  <main class="global-graph-view">
    <header class="editor-header"><div class="breadcrumbs"><span>我的知识库</span><span>›</span><span>知识图谱</span></div></header>
    <section class="global-graph-content">
      <div class="graph-view-heading"><div><p class="eyebrow">知识图谱</p><h1>关联网络</h1></div><div class="graph-filters"><input v-model="filter" placeholder="筛选页面或标签…" /><select v-model="sourceFilter" aria-label="筛选图谱存储源"><option :value="null">全部存储源</option><option v-for="source in store.workspace?.sources" :key="source.id" :value="source.id">{{ source.kind === 'smb' ? 'SMB · ' : '本地 · ' }}{{ source.name }}</option></select></div></div>
      <div class="global-graph-legend"><span class="legend-title">● 本地标题页</span><span class="legend-smb">● SMB 标题页</span><span class="legend-tag">■ 标签</span><span class="legend-content">◆ 内容抽象</span><span class="legend-cross-source">— 跨源链接</span><small>{{ graph.nodes.length }} 个节点 · {{ graph.edges.length }} 条关系</small></div>
      <div class="global-graph-canvas">
        <svg v-if="graph.nodes.length" viewBox="0 0 1000 680" aria-label="全局知识图谱">
          <line v-for="edge in graph.edges" :key="`${edge.kind}-${edge.from}-${edge.to}`" :class="[edge.kind, { 'cross-source': edge.crossSource }]" :x1="graph.nodes.find((node) => node.id === edge.from)?.x" :y1="graph.nodes.find((node) => node.id === edge.from)?.y" :x2="graph.nodes.find((node) => node.id === edge.to)?.x" :y2="graph.nodes.find((node) => node.id === edge.to)?.y" />
          <g v-for="node in graph.nodes" :key="node.id" class="global-graph-node" :class="[node.kind, node.sourceKind]" @click="selectNode(node)">
            <circle v-if="node.kind === 'title'" :cx="node.x" :cy="node.y" r="11" />
            <rect v-else-if="node.kind === 'tag'" :x="node.x - 11" :y="node.y - 8" width="22" height="16" rx="4" />
            <path v-else :d="`M ${node.x} ${node.y - 10} L ${node.x + 10} ${node.y} L ${node.x} ${node.y + 10} L ${node.x - 10} ${node.y} Z`" />
            <text :x="node.x" :y="node.y + 23">{{ node.label.slice(0, 11) }}</text>
          </g>
        </svg>
        <p v-else>没有可显示的页面。创建页面、标签或正文标题后，这里会自动建立关系。</p>
      </div>
    </section>
  </main>
</template>
