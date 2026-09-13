interface LabelNode {
  id: string
  label: string
  x: number
  y: number
  radius: number
  degree?: number
  current?: boolean
}

/** Draw labels in screen pixels so zooming creates space without enlarging text. */
export function drawGraphLabels(
  ctx: CanvasRenderingContext2D,
  nodes: LabelNode[],
  options: {
    width: number; height: number; scale: number; offsetX: number; offsetY: number
    focusId: string | null; neighbors: Set<string> | null
    text: string; textStrong: string; background: string; maxChars: number
  },
) {
  const { width, height, scale, offsetX, offsetY, focusId, neighbors } = options
  type Box = { left: number; right: number; top: number; bottom: number }
  const grid = new Map<string, Box[]>()
  const keys = (box: Box) => {
    const result: string[] = []
    for (let x = Math.floor(box.left / 64); x <= Math.floor(box.right / 64); x++) {
      for (let y = Math.floor(box.top / 64); y <= Math.floor(box.bottom / 64); y++) result.push(`${x}:${y}`)
    }
    return result
  }
  const priority = (node: LabelNode) => node.id === focusId ? 2 : node.current ? 1 : 0
  const candidates = nodes.filter(node => (!neighbors || neighbors.has(node.id) || node.current)
    && (scale > 0.55 || priority(node) > 0))
    .sort((a, b) => priority(b) - priority(a) || (b.degree ?? 0) - (a.degree ?? 0) || a.id.localeCompare(b.id))
  ctx.save()
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  for (const node of candidates) {
    const x = node.x * scale + offsetX
    const y = node.y * scale + offsetY
    const radius = node.radius * scale
    if (x + radius < 0 || x - radius > width || y + radius < 0 || y - radius > height) continue
    const chars = Array.from(node.label)
    const limit = node.id === focusId ? chars.length : options.maxChars
    let label = chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : node.label
    // Keep even a very long focused title within the viewport.
    if (ctx.measureText(label).width > width - 16) {
      let low = 0, high = chars.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (ctx.measureText(`${chars.slice(0, mid).join('')}…`).width <= width - 16) low = mid
        else high = mid - 1
      }
      label = `${chars.slice(0, low).join('')}…`
    }
    const textWidth = ctx.measureText(label).width
    const left = Math.max(8, Math.min(width - textWidth - 8, x - textWidth / 2))
    const top = y + radius + 4 + 15 <= height ? y + radius + 4 : y - radius - 19
    if (top < 0 || top + 15 > height) continue
    const box = { left: left - 4, right: left + textWidth + 4, top: top - 2, bottom: top + 15 }
    const cells = keys(box)
    if (cells.some(key => grid.get(key)?.some(other => box.left < other.right && box.right > other.left
      && box.top < other.bottom && box.bottom > other.top))) continue
    for (const key of cells) {
      const bucket = grid.get(key)
      if (bucket) bucket.push(box)
      else grid.set(key, [box])
    }
    ctx.strokeStyle = options.background
    ctx.lineWidth = 3
    ctx.lineJoin = 'round'
    ctx.strokeText(label, left, top)
    ctx.fillStyle = priority(node) ? options.textStrong : options.text
    ctx.fillText(label, left, top)
  }
  ctx.restore()
}
