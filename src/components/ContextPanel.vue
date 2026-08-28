<script setup lang="ts">
import { computed, ref } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'

const store = useWorkspaceStore()
const tab = ref<'outline' | 'properties' | 'links' | 'graph'>('outline')
const emit = defineEmits<{ close: [] }>()
const headings = computed(() => (store.activePage?.markdown.match(/^#{2,6} .+$/gm) ?? []).map((line, index) => ({ index, level: line.indexOf(' '), text: line.replace(/^#+ /, '') })))
const outgoing = computed(() => store.activePage ? store.outgoingLinks(store.activePage.id) : [])
const incoming = computed(() => store.activePage ? store.backlinks(store.activePage.id) : [])
const mentions = computed(() => store.activePage ? store.unlinkedMentions(store.activePage.id) : [])
const linkingMentionId = ref<string | null>(null)
const storageLabel = computed(() => {
  const source = store.allSources.find((item) => item.id === store.activePage?.storageSourceId)
  if (!source) return '未知存储源'
  if (source.kind === 'backend') return `后台 · ${source.name}`
  if (source.kind === 's3') return `S3 · ${source.name}`
  return source.kind === 'smb' ? `SMB · ${source.name}` : `本地 · ${source.name}`
})
const graph = computed(() => {
  const current = store.activePage
  if (!current) return { nodes: [], edges: [] }
  const linkedPages = [
    ...outgoing.value.map((page) => ({ page, relation: 'outgoing' as const })),
    ...incoming.value.map((page) => ({ page, relation: 'incoming' as const })),
  ].filter((item, index, all) => all.findIndex((candidate) => candidate.page.id === item.page.id) === index).slice(0, 8)
  const tags = current.tags.slice(0, 4).map((tag) => ({ id: `tag:${tag}`, title: `# ${tag}`, type: 'tag' as const, relation: 'tag' as const }))
  const concepts = (current.markdown.match(/^#{2,6} (.+)$/gm) ?? []).slice(0, 4).map((heading, index) => ({
    id: `concept:${current.id}:${index}`,
    title: heading.replace(/^#+ /, ''),
    type: 'content' as const,
    relation: 'content' as const,
    headingIndex: index,
  }))
  const neighbours = [
    ...linkedPages.map((item) => ({ id: item.page.id, title: item.page.title, type: 'title' as const, relation: item.relation })),
    ...tags,
    ...concepts,
  ].slice(0, 10)
  const nodes = [
    { id: current.id, title: current.title, type: 'title' as const, x: 120, y: 100, current: true },
    ...neighbours.map((item, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(neighbours.length, 1)
      return { id: item.id, title: item.title, type: item.type, headingIndex: item.type === 'content' ? item.headingIndex : undefined, x: 120 + Math.cos(angle) * 78, y: 100 + Math.sin(angle) * 70, current: false }
    }),
  ]
  return {
    nodes,
    edges: neighbours.map((item) => ({
      from: item.relation === 'incoming' ? item.id : current.id,
      to: item.relation === 'incoming' ? current.id : item.id,
      relation: item.relation,
    })),
  }
})

async function linkMention(sourcePageId: string) {
  const target = store.activePage
  if (!target) return
  linkingMentionId.value = sourcePageId
  try {
    await store.linkUnlinkedMention(sourcePageId, target.id)
  } finally {
    linkingMentionId.value = null
  }
}

function openGraphNode(node: { id: string; type: 'title' | 'tag' | 'content'; headingIndex?: number }) {
  if (node.type === 'title') {
    store.openPage(node.id)
    return
  }
  if (node.type === 'tag') store.openTags(node.id.slice('tag:'.length))
  if (node.type === 'content' && node.headingIndex !== undefined) store.scrollToOutlineHeading(node.headingIndex)
}

function isChildLink(pageId: string) {
  return store.pages.some((page) => page.id === pageId && page.parentId === store.activePage?.id && !page.deletedAt)
}

async function unlinkPage(pageId: string) {
  const source = store.activePage
  if (!source || isChildLink(pageId)) return
  await store.unlinkPageReference(source.id, pageId)
}
</script>

<template>
  <aside class="context-panel">
    <div class="context-tabs">
      <button :class="{ active: tab === 'outline' }" @click="tab = 'outline'">大纲</button>
      <button :class="{ active: tab === 'properties' }" @click="tab = 'properties'">属性</button>
      <button :class="{ active: tab === 'links' }" @click="tab = 'links'">链接</button>
      <button :class="{ active: tab === 'graph' }" @click="tab = 'graph'">图谱</button>
      <button class="context-collapse-button" type="button" title="收起右侧栏" aria-label="收起右侧栏" @click="emit('close')">‹</button>
    </div>
    <div v-if="tab === 'outline'" class="context-content outline-list">
      <p v-if="!headings.length" class="muted">添加标题后将在这里生成大纲。</p>
      <button v-for="heading in headings" :key="`${heading.index}-${heading.text}`" :style="{ paddingLeft: `${(heading.level - 1) * 10}px` }" @click="store.scrollToOutlineHeading(heading.index)">{{ heading.text }}</button>
    </div>
    <div v-else-if="tab === 'properties'" class="context-content property-list">
      <div><span>存储源</span><strong>{{ storageLabel }}</strong></div>
      <div><span>创建时间</span><strong>{{ store.activePage?.createdAt.slice(0, 10) }}</strong></div>
      <div><span>更新时间</span><strong>{{ store.activePage?.updatedAt.slice(0, 10) }}</strong></div>
      <div><span>页面 ID</span><code>{{ store.activePage?.id }}</code></div>
    </div>
    <div v-else-if="tab === 'links'" class="context-content link-panel">
      <section>
        <p class="context-section-title">链接到</p>
        <div v-for="page in outgoing" :key="page.id" class="outgoing-link-row">
          <button @click="store.openPage(page.id)"><span>↗</span>{{ page.title }}</button>
          <small v-if="isChildLink(page.id)" class="child-link-badge">子页面</small>
          <button v-else class="unlink-action" :title="`移除到“${page.title}”的页面链接`" @click="unlinkPage(page.id)">×</button>
        </div>
        <p v-if="!outgoing.length" class="muted">当前页面尚未链接到其他页面。</p>
      </section>
      <section>
        <p class="context-section-title">反向链接</p>
        <button v-for="page in incoming" :key="page.id" @click="store.openPage(page.id)"><span>↙</span>{{ page.title }}</button>
        <p v-if="!incoming.length" class="muted">还没有其他页面链接到这里。</p>
      </section>
      <section v-if="mentions.length">
        <p class="context-section-title">未链接提及</p>
        <div v-for="page in mentions" :key="page.id" class="mention-row">
          <button title="正文中出现了该页面标题，但尚未建立页面链接" @click="store.openPage(page.id)"><span>⌁</span>{{ page.title }}</button>
          <button class="mention-link-action" :disabled="linkingMentionId === page.id" :title="`将“${page.title}”中首次提及当前页的文字转换为页面链接`" @click="linkMention(page.id)">{{ linkingMentionId === page.id ? '关联中…' : '关联' }}</button>
        </div>
        <p class="mention-hint">正文中出现标题但未建立链接；可在编辑器中输入 [[ 进行关联。</p>
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
          :class="edge.relation"
          marker-end="url(#graph-arrow)"
        />
        <g v-for="node in graph.nodes" :key="node.id" class="graph-node" :class="{ current: node.current, interactive: true, [node.type]: true }" @click="openGraphNode(node)">
          <circle v-if="node.type === 'title'" :cx="node.x" :cy="node.y" :r="node.current ? 18 : 13" />
          <rect v-else-if="node.type === 'tag'" :x="node.x - 13" :y="node.y - 10" width="26" height="20" rx="5" />
          <path v-else :d="`M ${node.x} ${node.y - 13} L ${node.x + 13} ${node.y} L ${node.x} ${node.y + 13} L ${node.x - 13} ${node.y} Z`" />
          <text :x="node.x" :y="node.y + (node.current ? 31 : 25)">{{ node.title.slice(0, 8) }}</text>
        </g>
      </svg>
      <p v-else class="muted">用“链接页面”关联其他页面后，这里会呈现局部知识图谱。</p>
      <div v-if="graph.nodes.length > 1" class="graph-legend"><span class="legend-title">● 标题页</span><span class="legend-tag">■ 标签</span><span class="legend-content">◆ 内容抽象</span></div>
      <p v-if="graph.nodes.length > 1" class="graph-caption">实线为页面链接，虚线为标签关系，点线为正文内容抽象；可点击标题页节点打开页面。</p>
    </div>
  </aside>
</template>
