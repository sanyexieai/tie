<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TieSelect from '@/components/TieSelect.vue'
import { readGraphPalette } from '@/services/theme'
import { useWorkspaceStore } from '@/stores/workspace'

const depthOptions = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
]

interface SimNode {
  id: string
  label: string
  kind: 'page' | 'tag'
  pageId?: string
  tag?: string
  current?: boolean
  x: number
  y: number
  vx: number
  vy: number
  radius: number
}

interface SimEdge {
  from: string
  to: string
  kind: 'link' | 'tag'
}

const store = useWorkspaceStore()
const showTags = ref(false)
const depth = ref(1)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const wrapEl = ref<HTMLElement | null>(null)
const nodeCount = ref(0)
const hoveredId = ref<string | null>(null)
const selectedId = ref<string | null>(null)

let simNodes: SimNode[] = []
let simEdges: SimEdge[] = []
let nodeIndex = new Map<string, SimNode>()
let neighborCache = new Set<string>()
let neighborFocus: string | null = null

let raf = 0
let running = true
let needsDraw = true
let width = 260
let height = 240
let dpr = 1
let viewX = 0
let viewY = 0
let scale = 1
let draggingNode: SimNode | null = null
let panning = false
let lastPointer = { x: 0, y: 0 }
let downPointer = { x: 0, y: 0 }
let settledFrames = 0

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
  rebuildNeighborCache()
  settledFrames = 0
  running = true
  needsDraw = true
}

function buildGraph() {
  const current = store.activePage
  if (!current || current.deletedAt) {
    setSimGraph([], [])
    return
  }

  const levels = new Map<string, number>([[current.id, 0]])
  const queue = [current.id]
  const maxDepth = Math.max(1, Math.min(3, depth.value))

  while (queue.length) {
    const id = queue.shift()!
    const level = levels.get(id) ?? 0
    if (level >= maxDepth) continue
    const related = [
      ...store.outgoingLinks(id),
      ...store.backlinks(id),
    ]
    for (const page of related) {
      if (levels.has(page.id)) continue
      levels.set(page.id, level + 1)
      queue.push(page.id)
    }
  }

  const pageIds = [...levels.keys()].filter((id) => id !== current.id).slice(0, 18)
  const pageById = new Map(store.pages.map((page) => [page.id, page]))

  const pageNodes: SimNode[] = [
    {
      id: current.id,
      label: current.title || '无标题',
      kind: 'page',
      pageId: current.id,
      current: true,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: 11,
    },
    ...pageIds.map((id, index) => {
      const page = pageById.get(id)
      const level = levels.get(id) ?? 1
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(pageIds.length, 1)
      const radius = 48 + level * 28
      return {
        id,
        label: page?.title || '无标题',
        kind: 'page' as const,
        pageId: id,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * (radius * 0.82),
        vx: 0,
        vy: 0,
        radius: level === 1 ? 7 : 5.5,
      }
    }),
  ]

  const visible = new Set(pageNodes.map((node) => node.id))
  const nextEdges: SimEdge[] = []
  for (const id of visible) {
    for (const page of store.outgoingLinks(id)) {
      if (!visible.has(page.id)) continue
      nextEdges.push({ from: id, to: page.id, kind: 'link' })
    }
  }

  if (showTags.value) {
    const tags = current.tags.slice(0, 6)
    for (const [index, tag] of tags.entries()) {
      const angle = (index * Math.PI * 2) / Math.max(tags.length, 1)
      pageNodes.push({
        id: `tag:${tag}`,
        label: `#${tag}`,
        kind: 'tag',
        tag,
        x: Math.cos(angle) * 36,
        y: Math.sin(angle) * 30,
        vx: 0,
        vy: 0,
        radius: 5,
      })
      nextEdges.push({ from: current.id, to: `tag:${tag}`, kind: 'tag' })
    }
  }

  setSimGraph(pageNodes, nextEdges)
  viewX = 0
  viewY = 0
  scale = 1
}

function stepForces() {
  const list = simNodes
  if (list.length < 2) return
  const alpha = Math.max(0.03, 0.2 - settledFrames * 0.002)

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]
      const b = list[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let dist = Math.hypot(dx, dy) || 0.01
      const minDist = a.radius + b.radius + 14
      if (dist < minDist) dist = minDist
      const force = (900 * alpha) / (dist * dist)
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      if (a !== draggingNode && !a.current) { a.vx -= fx; a.vy -= fy }
      if (b !== draggingNode && !b.current) { b.vx += fx; b.vy += fy }
    }
  }

  for (const edge of simEdges) {
    const a = nodeIndex.get(edge.from)
    const b = nodeIndex.get(edge.to)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.hypot(dx, dy) || 0.01
    const ideal = edge.kind === 'tag' ? 48 : 68
    const force = (dist - ideal) * 0.05 * alpha
    const fx = (dx / dist) * force
    const fy = (dy / dist) * force
    if (a !== draggingNode && !a.current) { a.vx += fx; a.vy += fy }
    if (b !== draggingNode && !b.current) { b.vx -= fx; b.vy -= fy }
  }

  for (const node of list) {
    if (node.current) {
      node.x *= 0.85
      node.y *= 0.85
      node.vx = 0
      node.vy = 0
      continue
    }
    if (node === draggingNode) {
      node.vx = 0
      node.vy = 0
      continue
    }
    node.vx += (-node.x) * 0.008 * alpha
    node.vy += (-node.y) * 0.008 * alpha
    node.vx *= 0.8
    node.vy *= 0.8
    node.x += node.vx
    node.y += node.vy
  }

  settledFrames += 1
  if (settledFrames > 180) running = false
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
    if (dist <= node.radius + 5 / scale && dist < bestDist) {
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
  const gradient = ctx.createRadialGradient(width / 2, height / 2, 20, width / 2, height / 2, Math.max(width, height) * 0.75)
  gradient.addColorStop(0, palette.bg0)
  gradient.addColorStop(1, palette.bg1)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  if (!simNodes.length) {
    ctx.fillStyle = palette.textMuted
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('暂无关联页面', width / 2, height / 2)
    return
  }

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
    ctx.lineWidth = (active ? 1.3 : 0.8) / scale
    ctx.stroke()
  }

  for (const node of simNodes) {
    const active = !focus || focus.has(node.id)
    const isFocus = node.id === hoveredId.value || node.id === selectedId.value || Boolean(node.current)
    ctx.beginPath()
    ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2)
    if (node.kind === 'tag') {
      ctx.fillStyle = active ? palette.tagNode : palette.tagNodeDim
    } else if (node.current) {
      ctx.fillStyle = palette.nodeActive
    } else {
      ctx.fillStyle = active ? palette.node : palette.nodeDim
    }
    ctx.fill()
    if (isFocus) {
      ctx.strokeStyle = palette.ring
      ctx.lineWidth = 1.6 / scale
      ctx.stroke()
    }

    if (active) {
      ctx.font = `${node.current ? 11 : 10}px ui-sans-serif, system-ui, sans-serif`
      ctx.fillStyle = node.current ? palette.textStrong : palette.text
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      const label = node.label.length > 10 ? `${node.label.slice(0, 9)}…` : node.label
      ctx.fillText(label, node.x, node.y + node.radius + 3)
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
  width = Math.max(200, wrap.clientWidth)
  height = Math.max(220, wrap.clientHeight)
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
    running = true
    settledFrames = 0
    needsDraw = true
  } else {
    panning = true
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
  const world = screenToWorld(event.clientX, event.clientY)
  const hit = draggingNode || hitTest(world.x, world.y)
  if (hit && moved < 5) {
    if (hit.kind === 'page' && hit.pageId && !hit.current) {
      window.setTimeout(() => store.openPage(hit.pageId!), 0)
    } else if (hit.kind === 'tag' && hit.tag) {
      // Obsidian: focus/highlight tag connections instead of leaving the editor.
      selectedId.value = hit.id
      rebuildNeighborCache()
      needsDraw = true
    }
  } else if (moved < 5) {
    selectedId.value = null
    rebuildNeighborCache()
  }
  draggingNode = null
  panning = false
  needsDraw = true
}

function onWheel(event: WheelEvent) {
  event.preventDefault()
  scale = Math.min(2.8, Math.max(0.45, scale * (event.deltaY > 0 ? 0.92 : 1.08)))
  needsDraw = true
}

function onThemeChanged() {
  needsDraw = true
  draw()
}

watch(() => store.activePageId, () => buildGraph())
watch(() => store.activePage?.updatedAt, () => buildGraph())
watch(() => store.links.length, () => buildGraph())
watch([showTags, depth], () => buildGraph())

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
  <div class="local-obsidian-graph">
    <div class="local-obsidian-toolbar">
      <label class="graph-toggle"><input v-model="showTags" type="checkbox" />标签</label>
      <label class="graph-toggle" title="关联深度（类似 Obsidian Local Graph Depth）">
        深度
        <TieSelect v-model="depth" compact :options="depthOptions" aria-label="图谱深度" />
      </label>
      <small>{{ nodeCount }} 节点</small>
    </div>
    <div ref="wrapEl" class="local-obsidian-stage">
      <canvas
        ref="canvasEl"
        class="local-obsidian-canvas"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @wheel.prevent="onWheel"
      />
    </div>
    <p class="local-obsidian-caption">悬停高亮 · 点页面打开 · 点标签聚焦 · 深度可调</p>
  </div>
</template>
