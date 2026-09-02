import { onBeforeUnmount, ref, type Ref } from 'vue'

export type PageDropPosition = 'before' | 'after' | 'inside'

export function usePageTreePointerDrag(
  treeRootRef: Ref<HTMLElement | null>,
  callbacks: {
    onMove: (pageId: string, targetId: string, position: PageDropPosition) => void
    onMoveTopLevel?: (pageId: string) => void
  },
) {
  const draggingPageId = ref<string | null>(null)
  const dropTargetId = ref<string | null>(null)
  const dropPosition = ref<PageDropPosition | null>(null)
  const topLevelDragOver = ref(false)
  let activePointerId: number | null = null

  function clearDropState() {
    dropTargetId.value = null
    dropPosition.value = null
    topLevelDragOver.value = false
  }

  function finishDrag() {
    draggingPageId.value = null
    activePointerId = null
    clearDropState()
    document.body.classList.remove('page-tree-reordering')
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
  }

  function updateDropFromPoint(clientX: number, clientY: number) {
    const sourceId = draggingPageId.value
    const root = treeRootRef.value
    if (!sourceId || !root) {
      clearDropState()
      return
    }

    const topZone = root.querySelector<HTMLElement>('.top-level-drop-zone')
    if (topZone && callbacks.onMoveTopLevel) {
      const bounds = topZone.getBoundingClientRect()
      if (
        clientX >= bounds.left
        && clientX <= bounds.right
        && clientY >= bounds.top
        && clientY <= bounds.bottom
      ) {
        dropTargetId.value = null
        dropPosition.value = null
        topLevelDragOver.value = true
        return
      }
    }
    topLevelDragOver.value = false

    const rows = [...root.querySelectorAll<HTMLElement>('[data-page-tree-id]')]
    let best: { id: string; position: PageDropPosition; distance: number } | null = null

    for (const row of rows) {
      const id = row.dataset.pageTreeId
      if (!id || id === sourceId) continue
      const bounds = row.getBoundingClientRect()
      if (
        clientX < bounds.left
        || clientX > bounds.right
        || clientY < bounds.top
        || clientY > bounds.bottom
      ) continue

      const relativeY = (clientY - bounds.top) / bounds.height
      const position: PageDropPosition = relativeY < 0.27
        ? 'before'
        : relativeY > 0.73
          ? 'after'
          : 'inside'
      const anchorY = position === 'before'
        ? bounds.top
        : position === 'after'
          ? bounds.bottom
          : bounds.top + bounds.height / 2
      const distance = Math.abs(clientY - anchorY)
      if (!best || distance < best.distance) best = { id, position, distance }
    }

    if (!best) {
      clearDropState()
      return
    }
    dropTargetId.value = best.id
    dropPosition.value = best.position
  }

  function onPointerMove(event: PointerEvent) {
    if (activePointerId !== null && event.pointerId !== activePointerId) return
    if (!draggingPageId.value) return
    event.preventDefault()
    updateDropFromPoint(event.clientX, event.clientY)
  }

  function onPointerUp(event: PointerEvent) {
    if (activePointerId !== null && event.pointerId !== activePointerId) return
    const pageId = draggingPageId.value
    const targetId = dropTargetId.value
    const position = dropPosition.value
    const toTop = topLevelDragOver.value
    finishDrag()
    if (!pageId) return
    if (toTop && callbacks.onMoveTopLevel) {
      callbacks.onMoveTopLevel(pageId)
      return
    }
    if (!targetId || !position || pageId === targetId) return
    callbacks.onMove(pageId, targetId, position)
  }

  function startPointerDrag(event: PointerEvent, pageId: string) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    finishDrag()
    draggingPageId.value = pageId
    activePointerId = event.pointerId
    document.body.classList.add('page-tree-reordering')
    const handle = event.currentTarget
    if (handle instanceof HTMLElement) {
      try { handle.setPointerCapture(event.pointerId) } catch { /* WebView 偶发不支持 */ }
    }
    window.addEventListener('pointermove', onPointerMove, { passive: false })
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    updateDropFromPoint(event.clientX, event.clientY)
  }

  onBeforeUnmount(finishDrag)

  return {
    draggingPageId,
    dropTargetId,
    dropPosition,
    topLevelDragOver,
    startPointerDrag,
    finishDrag,
  }
}
