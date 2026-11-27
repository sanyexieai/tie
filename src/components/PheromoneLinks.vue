<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { PHEROMONE_KIND_COLOR, pheromoneState, type PheromoneKind } from '@/services/pheromone'
import { protectedPagesRevision } from '@/services/protected-pages'

const paths = ref<Array<{ id: string; d: string; color: string; active: boolean }>>([])
let frame = 0
let lastSignature = ''

function measure() {
  if (!pheromoneState.panelOpen) {
    if (paths.value.length) {
      paths.value = []
      lastSignature = ''
    }
    return
  }
  const editor = document.querySelector('.editor-scroll')
  const editorRect = editor?.getBoundingClientRect()
  const next: Array<{ id: string; d: string; color: string; active: boolean }> = []
  if (!editorRect) {
    if (lastSignature) {
      paths.value = []
      lastSignature = ''
    }
    return
  }
  for (const card of document.querySelectorAll<HTMLElement>('[data-pheromone-card]')) {
    const id = card.dataset.pheromoneCard
    if (!id) continue
    const mark = document.querySelector<HTMLElement>(`[data-pheromone-id="${CSS.escape(id)}"]`)
    if (!mark) continue
    const markRect = mark.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const panel = card.closest('.context-content, .context-panel')
    const panelRect = panel?.getBoundingClientRect()
    if (panelRect && (panelRect.width < 8 || panelRect.height < 8)) continue
    const visibleTop = Math.max(markRect.top, editorRect.top)
    const visibleBottom = Math.min(markRect.bottom, editorRect.bottom)
    const y = visibleBottom > visibleTop
      ? (visibleTop + visibleBottom) / 2
      : (markRect.bottom < editorRect.top ? editorRect.top + 10 : editorRect.bottom - 10)
    const x1 = Math.min(Math.max(markRect.right + 2, editorRect.left + 8), editorRect.right - 6)
    // 卡片滚出「变更」面板时，线停在面板边缘，不再跟到窗口外面。
    let y2 = cardRect.top + Math.min(Math.max(cardRect.height, 0) / 2, 28)
    let x2 = cardRect.left
    if (panelRect) {
      const above = cardRect.bottom < panelRect.top + 8
      const below = cardRect.top > panelRect.bottom - 8
      if (above || below) {
        x2 = panelRect.left
        y2 = above ? panelRect.top + 12 : panelRect.bottom - 12
      }
    }
    const bend = x1 + Math.max(28, (x2 - x1) * 0.42)
    const kind = (card.dataset.pheromoneKind || 'support') as PheromoneKind
    next.push({
      id,
      d: `M ${x1.toFixed(1)} ${y.toFixed(1)} C ${bend.toFixed(1)} ${y.toFixed(1)}, ${bend.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`,
      color: PHEROMONE_KIND_COLOR[kind] ?? PHEROMONE_KIND_COLOR.support,
      active: id === pheromoneState.activeId,
    })
  }
  const signature = next.map((path) => `${path.id}:${path.d}:${path.active}`).join('|')
  if (signature === lastSignature) return
  lastSignature = signature
  paths.value = next
}

function loop() {
  measure()
  frame = requestAnimationFrame(loop)
}

watch(() => pheromoneState.panelOpen, (open) => {
  cancelAnimationFrame(frame)
  frame = 0
  if (!open) {
    paths.value = []
    return
  }
  frame = requestAnimationFrame(loop)
}, { immediate: true })

watch(protectedPagesRevision, () => {
  paths.value = []
  lastSignature = ''
}, { flush: 'sync' })

onBeforeUnmount(() => cancelAnimationFrame(frame))
</script>

<template>
  <svg class="pheromone-links" aria-hidden="true">
    <path
      v-for="path in paths"
      :key="path.id"
      :d="path.d"
      :stroke="path.color"
      :stroke-width="path.active ? 2.25 : 1.25"
      :opacity="path.active ? 0.95 : 0.45"
      fill="none"
      stroke-linecap="round"
    />
  </svg>
</template>
