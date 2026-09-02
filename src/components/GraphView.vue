<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TieSelect from '@/components/TieSelect.vue'
import { pageBoundToSource } from '@/services/page-sources'
import { readGraphPalette } from '@/services/theme'
import { useWorkspaceStore } from '@/stores/workspace'

interface SimNode {
  id: string
  label: string
  kind: 'page' | 'tag'
  pageId?: string
  tag?: string
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  degree: number
}

interface SimEdge {
  from: string
  to: string
  kind: 'link' | 'tag'
}

const store = useWorkspaceStore()
const filter = ref('')
const sourceFilter = ref<string | null>(null)
const sourceFilterOptions = computed(() => [
  { value: null as string | null, label: '全部存储源' },
  ...store.allSources.map((source) => ({
    value: source.id as string | null,
    label: `${source.kind === 'backend' ? '后台 · ' : source.kind === 's3' ? 'S3 · ' : source.kind === 'smb' ? 'SMB · ' : '本地 · '}${source.name}`,
  })),
])
const tagFilter = ref<string | null>(null)
const showTags = ref(true)
const showOrphans = ref(true)
const hoveredId = ref<string | null>(null)
const selectedId = ref<string | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const wrapEl = ref<HTMLElement | null>(null)
const nodeCount = ref(0)
const pageNodeCount = ref(0)
const tagNodeCount = ref(0)
const edgeCount = ref(0)

// Keep simulation state out of Vue reactivity — mutating reactive nodes every frame freezes the UI.
let simNodes: SimNode[] = []
let simEdges: SimEdge[] = []
let nodeIndex = new Map<string, SimNode>()
let neighborCache = new Set<string>()
let neighborFocus: string | null = null

let raf = 0
let running = true
let needsDraw = true
let width = 960
let height = 640
let dpr = 1
let viewX = 0
let viewY = 0
let scale = 1
let draggingNode: SimNode | null = null
let panning = false
let lastPointer = { x: 0, y: 0 }
let downPointer = { x: 0, y: 0 }
let settledFrames = 0

const MAX_PAGE_NODES = 2000
const MAX_TAG_NODES = 48

function rebuildNeighborCache() {
  const focus = hoveredId.value || selectedId.value
  neighborFocus = focus
  if (!focus) {
    neighborCache = new Set()
    return
  }
  const set = new Set<string>([focus])
  for (const edge of simEdges) {
    if (edge.from === focus) set.add(edge.to)
    if (edge.to === focus) set.add(edge.from)
  }
  neighborCache = set
}

function setSimGraph(nextNodes: SimNode[], nextEdges: SimEdge[]) {
  simNodes = nextNodes
  simEdges = nextEdges
  nodeIndex = new Map(nextNodes.map((node) => [node.id, node]))
  nodeCount.value = nextNodes.length
  pageNodeCount.value = nextNodes.filter((node) => node.kind === 'page').length
  tagNodeCount.value = nextNodes.filter((node) => node.kind === 'tag').length
  edgeCount.value = nextEdges.length
  rebuildNeighborCache()
  settledFrames = 0
  running = true
  needsDraw = true
}

function buildGraph() {
  const query = filter.value.trim().toLocaleLowerCase()
  const activeTag = tagFilter.value
  // When a tag is focused (Obsidian-style), keep tags visible so the hub stays on screen.
  const includeTags = showTags.value || Boolean(activeTag)
  const pages = store.pages.filter((page) => (
    !page.deletedAt
    && (!sourceFilter.value || pageBoundToSource(page, sourceFilter.value))
    && (!activeTag || page.tags.includes(activeTag))
    && (!query || `${page.title} ${page.tags.join(' ')}`.toLocaleLowerCase().includes(query))
  ))
  const pageIds = new Set(pages.map((page) => page.id))
  const linkEdges = store.links
    .filter((link) => pageIds.has(link.fromPageId) && pageIds.has(link.toPageId))
    .map((link) => ({ from: link.fromPageId, to: link.toPageId, kind: 'link' as const }))

  // 树父子关系也是图谱边（不依赖正文里是否还留着子页链接）。
  const treeEdges: SimEdge[] = []
  for (const page of pages) {
    if (!page.parentId || !pageIds.has(page.parentId)) continue
    treeEdges.push({ from: page.parentId, to: page.id, kind: 'link' })
  }

  const degree = new Map<string, number>()
  for (const edge of [...linkEdges, ...treeEdges]) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }

  let pageNodes = pages
    .map((page) => {
      const deg = degree.get(page.id) ?? 0
      return {
        id: page.id,
        label: page.title || '无标题',
        kind: 'page' as const,
        pageId: page.id,
        x: (Math.random() - 0.5) * Math.min(width, 800),
        y: (Math.random() - 0.5) * Math.min(height, 560),
        vx: 0,
        vy: 0,
        degree: deg,
        radius: Math.min(16, 4 + Math.sqrt(deg + 1) * 2.4),
      }
    })
    .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label, 'zh-CN'))

  if (!showOrphans.value && !activeTag) {
    pageNodes = pageNodes.filter((node) => node.degree > 0)
  }

  if (pageNodes.length > MAX_PAGE_NODES) {
    pageNodes = pageNodes.slice(0, MAX_PAGE_NODES)
  }

  const visiblePageIds = new Set(pageNodes.map((node) => node.id))
  const edgeKey = new Set<string>()
  const nextEdges: SimEdge[] = []
  for (const edge of [...linkEdges, ...treeEdges]) {
    if (!visiblePageIds.has(edge.from) || !visiblePageIds.has(edge.to)) continue
    const key = `${edge.from}\0${edge.to}\0${edge.kind}`
    if (edgeKey.has(key)) continue
    edgeKey.add(key)
    nextEdges.push(edge)
  }
  const pageById = new Map(pages.map((page) => [page.id, page]))

  if (includeTags) {
    const tagCounts = new Map<string, number>()
    for (const node of pageNodes) {
      const page = pageById.get(node.id)
      if (!page) continue
      for (const tag of page.tags) {
        if (activeTag && tag !== activeTag) continue
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
      }
    }
    const tagNames = activeTag
      ? [activeTag]
      : [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
        .slice(0, MAX_TAG_NODES)
        .map(([name]) => name)
    const tagSet = new Set(tagNames)
    const tagNodes = tagNames.map((tag) => ({
      id: `tag:${tag}`,
      label: `#${tag}`,
      kind: 'tag' as const,
      tag,
      x: (Math.random() - 0.5) * 360,
      y: (Math.random() - 0.5) * 260,
      vx: 0,
      vy: 0,
      degree: tagCounts.get(tag) ?? pageNodes.length,
      radius: Math.min(12, 5 + Math.sqrt((tagCounts.get(tag) ?? pageNodes.length)) * 1.8),
    }))
    for (const node of pageNodes) {
      const page = pageById.get(node.id)
      if (!page) continue
      for (const tag of page.tags) {
        if (!tagSet.has(tag)) continue
        nextEdges.push({ from: page.id, to: `tag:${tag}`, kind: 'tag' })
      }
    }
    setSimGraph([...pageNodes, ...tagNodes], nextEdges)
    if (activeTag) {
      selectedId.value = `tag:${activeTag}`
      rebuildNeighborCache()
    }
  } else {
    setSimGraph(pageNodes, nextEdges)
  }
}

function clearTagFilter() {
  tagFilter.value = null
  selectedId.value = null
  buildGraph()
}

function focusTag(tag: string) {
  // Obsidian: clicking a tag filters the graph to that tag — do not leave the graph view.
  tagFilter.value = tag
  showTags.value = true
  selectedId.value = `tag:${tag}`
  buildGraph()
}

function stepForces() {
  const list = simNodes
  if (!list.length) return
  const alpha = Math.max(0.02, 0.2 - settledFrames * 0.0018)
  const n = list.length

  // Spatial grid to avoid O(n²) freezes on large graphs.
  const cellSize = 48
  const grid = new Map<string, number[]>()
  for (let i = 0; i < n; i += 1) {
    const node = list[i]
    const key = `${Math.floor(node.x / cellSize)}:${Math.floor(node.y / cellSize)}`
    const bucket = grid.get(key)
    if (bucket) bucket.push(i)
    else grid.set(key, [i])
  }

  for (let i = 0; i < n; i += 1) {
    const a = list[i]
    const cx = Math.floor(a.x / cellSize)
    const cy = Math.floor(a.y / cellSize)
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        const bucket = grid.get(`${cx + ox}:${cy + oy}`)
        if (!bucket) continue
        for (const j of bucket) {
          if (j <= i) continue
          const b = list[j]
          let dx = b.x - a.x
          let dy = b.y - a.y
          let dist = Math.hypot(dx, dy) || 0.01
          const minDist = a.radius + b.radius + 16
          if (dist < minDist) dist = minDist
          if (dist > cellSize * 1.6) continue
          const force = (1400 * alpha) / (dist * dist)
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          if (a !== draggingNode) { a.vx -= fx; a.vy -= fy }
          if (b !== draggingNode) { b.vx += fx; b.vy += fy }
        }
      }
    }
  }

  for (const edge of simEdges) {
    const a = nodeIndex.get(edge.from)
    const b = nodeIndex.get(edge.to)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.hypot(dx, dy) || 0.01
    const ideal = edge.kind === 'tag' ? 88 : 118
    const force = (dist - ideal) * 0.03 * alpha
    const fx = (dx / dist) * force
    const fy = (dy / dist) * force
    if (a !== draggingNode) { a.vx += fx; a.vy += fy }
    if (b !== draggingNode) { b.vx -= fx; b.vy -= fy }
  }

  for (const node of list) {
    if (node === draggingNode) {
      node.vx = 0
      node.vy = 0
      continue
    }
    node.vx += (-node.x) * 0.004 * alpha
    node.vy += (-node.y) * 0.004 * alpha
    node.vx *= 0.84
    node.vy *= 0.84
    node.x += node.vx
    node.y += node.vy
  }

  settledFrames += 1
  if (settledFrames > 200) running = false
  needsDraw = true
}

function screenToWorld(clientX: number, clientY: number) {
  const rect = canvasEl.value?.getBoundingClientRect()
  if (!rect) return { x: 0, y: 0 }
  return {
    x: (clientX - rect.left - width / 2 - viewX) / scale,
    y: (clientY - rect.top - height / 2 - viewY) / scale,
  }
}

function hitTest(worldX: number, worldY: number) {
  let best: SimNode | null = null
  let bestDist = Infinity
  for (const node of simNodes) {
    const dist = Math.hypot(node.x - worldX, node.y - worldY)
    if (dist <= node.radius + 6 / scale && dist < bestDist) {
      best = node
      bestDist = dist
    }
  }
  return best
}

function draw() {
  const canvas = canvasEl.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  needsDraw = false

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const palette = readGraphPalette()
  const gradient = ctx.createRadialGradient(width / 2, height / 2, 40, width / 2, height / 2, Math.max(width, height) * 0.7)
  gradient.addColorStop(0, palette.bg0)
  gradient.addColorStop(1, palette.bg1)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  ctx.save()
  ctx.translate(width / 2 + viewX, height / 2 + viewY)
  ctx.scale(scale, scale)

  const focus = neighborFocus ? neighborCache : null

  for (const edge of simEdges) {
    const a = nodeIndex.get(edge.from)
    const b = nodeIndex.get(edge.to)
    if (!a || !b) continue
    const active = !focus || (focus.has(edge.from) && focus.has(edge.to))
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.strokeStyle = edge.kind === 'tag'
      ? (active ? palette.tagLink : palette.tagLinkDim)
      : (active ? palette.link : palette.linkDim)
    ctx.lineWidth = (active ? 1.8 : 1.15) / scale
    ctx.stroke()
  }

  for (const node of simNodes) {
    const active = !focus || focus.has(node.id)
    const isFocus = node.id === (hoveredId.value || selectedId.value)
    ctx.beginPath()
    ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2)
    if (node.kind === 'tag') {
      ctx.fillStyle = active ? palette.tagNode : palette.tagNodeDim
    } else {
      ctx.fillStyle = isFocus
        ? palette.nodeActive
        : active
          ? palette.node
          : palette.nodeDim
    }
    ctx.fill()
    if (isFocus) {
      ctx.strokeStyle = palette.ring
      ctx.lineWidth = 2 / scale
      ctx.stroke()
    }

    if (active && scale > 0.55) {
      ctx.font = `${Math.max(10, 11 / scale)}px ui-sans-serif, system-ui, sans-serif`
      ctx.fillStyle = isFocus ? palette.textStrong : palette.text
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      const label = node.label.length > 16 ? `${node.label.slice(0, 15)}…` : node.label
      ctx.fillText(label, node.x, node.y + node.radius + 4 / scale)
    }
  }

  ctx.restore()
}

function frame() {
  if (running) stepForces()
  if (needsDraw || running || draggingNode || panning) draw()
  raf = window.requestAnimationFrame(frame)
}

function resize() {
  const wrap = wrapEl.value
  const canvas = canvasEl.value
  if (!wrap || !canvas) return
  width = Math.max(320, wrap.clientWidth)
  height = Math.max(420, wrap.clientHeight)
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.floor(width * dpr)
  canvas.height = Math.floor(height * dpr)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  needsDraw = true
  draw()
}

function onPointerDown(event: PointerEvent) {
  const world = screenToWorld(event.clientX, event.clientY)
  const hit = hitTest(world.x, world.y)
  lastPointer = { x: event.clientX, y: event.clientY }
  downPointer = { x: event.clientX, y: event.clientY }
  if (hit) {
    draggingNode = hit
    selectedId.value = hit.id
    rebuildNeighborCache()
    running = true
    settledFrames = 0
    needsDraw = true
  } else {
    panning = true
    selectedId.value = null
    rebuildNeighborCache()
    needsDraw = true
  }
  canvasEl.value?.setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  const world = screenToWorld(event.clientX, event.clientY)
  if (draggingNode) {
    draggingNode.x = world.x
    draggingNode.y = world.y
    draggingNode.vx = 0
    draggingNode.vy = 0
    running = true
    settledFrames = 0
    needsDraw = true
  } else if (panning) {
    viewX += event.clientX - lastPointer.x
    viewY += event.clientY - lastPointer.y
    lastPointer = { x: event.clientX, y: event.clientY }
    needsDraw = true
  } else {
    const hit = hitTest(world.x, world.y)
    const nextId = hit?.id ?? null
    if (nextId !== hoveredId.value) {
      hoveredId.value = nextId
      rebuildNeighborCache()
      needsDraw = true
    }
    if (canvasEl.value) canvasEl.value.style.cursor = hit ? 'pointer' : 'grab'
  }
}

function onPointerUp(event: PointerEvent) {
  const moved = Math.hypot(event.clientX - downPointer.x, event.clientY - downPointer.y)
  if (draggingNode && moved < 5) {
    const node = draggingNode
    if (node.kind === 'page' && node.pageId) {
      window.setTimeout(() => store.openPage(node.pageId!), 0)
    } else if (node.kind === 'tag' && node.tag) {
      // Stay in graph and filter — same idea as Obsidian tag click.
      focusTag(node.tag)
    }
  }
  draggingNode = null
  panning = false
  needsDraw = true
}

function onWheel(event: WheelEvent) {
  event.preventDefault()
  const delta = event.deltaY > 0 ? 0.92 : 1.08
  scale = Math.min(3.5, Math.max(0.25, scale * delta))
  needsDraw = true
}

function resetView() {
  viewX = 0
  viewY = 0
  scale = 1
  tagFilter.value = null
  selectedId.value = null
  buildGraph()
}

function onThemeChanged() {
  needsDraw = true
  draw()
}

watch(() => store.allSources.map((source) => source.id).join('\n'), () => {
  if (sourceFilter.value && !store.allSources.some((source) => source.id === sourceFilter.value)) {
    sourceFilter.value = null
  }
  buildGraph()
})

watch([filter, sourceFilter, showTags, showOrphans, tagFilter], () => {
  buildGraph()
})

watch(() => store.pages.map((page) => `${page.id}:${page.parentId}:${page.updatedAt}:${page.tags.join(',')}`).join('|'), () => buildGraph())
watch(() => store.links.map((link) => `${link.fromPageId}->${link.toPageId}`).join('|'), () => buildGraph())

onMounted(() => {
  resize()
  buildGraph()
  raf = window.requestAnimationFrame(frame)
  window.addEventListener('resize', resize)
  window.addEventListener('tie:theme-changed', onThemeChanged)
})

onBeforeUnmount(() => {
  window.cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
  window.removeEventListener('tie:theme-changed', onThemeChanged)
  simNodes = []
  simEdges = []
  nodeIndex.clear()
})
</script>

<template>
  <main class="global-graph-view obsidian-graph">
    <header class="editor-header">
      <div class="breadcrumbs">
        <span>{{ store.workspace?.name ?? '我的知识库' }}</span>
        <span>›</span>
        <span>知识图谱</span>
      </div>
      <div class="graph-toolbar">
        <input v-model="filter" type="search" placeholder="筛选页面…" />
        <TieSelect v-model="sourceFilter" :options="sourceFilterOptions" aria-label="筛选存储源" />
        <label class="graph-toggle"><input v-model="showTags" type="checkbox" />标签</label>
        <label class="graph-toggle"><input v-model="showOrphans" type="checkbox" />孤立页</label>
        <button v-if="tagFilter" type="button" class="graph-reset" :title="`清除标签筛选 #${tagFilter}`" @click="clearTagFilter">#{{ tagFilter }} ×</button>
        <button type="button" class="graph-reset" @click="resetView">重置</button>
      </div>
    </header>

    <section ref="wrapEl" class="obsidian-graph-stage">
      <canvas
        ref="canvasEl"
        class="obsidian-graph-canvas"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @wheel.prevent="onWheel"
      />
      <div class="obsidian-graph-hint">
        <span>{{ pageNodeCount }} 页面 · {{ edgeCount }} 连线{{ tagNodeCount ? ` · ${tagNodeCount} 标签` : '' }}</span>
        <span>悬停高亮 · 点页面打开 · 点标签筛选 · 拖拽 / 缩放</span>
      </div>
      <p v-if="!nodeCount" class="obsidian-graph-empty">没有可显示的页面。创建页面、加标签，或用 `[[` / 页面链接关联后会出现网络。</p>
    </section>
  </main>
</template>
