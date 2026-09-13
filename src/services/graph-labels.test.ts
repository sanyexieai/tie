import { describe, expect, it } from 'vitest'
import { drawGraphLabels } from './graph-labels'

function render(nodes: Parameters<typeof drawGraphLabels>[1], overrides = {}) {
  const drawn: string[] = []
  const ctx = {
    save() {}, restore() {}, strokeText() {},
    measureText: (text: string) => ({ width: Array.from(text).length * 11 }),
    fillText: (text: string) => drawn.push(text),
  } as unknown as CanvasRenderingContext2D
  drawGraphLabels(ctx, nodes, {
    width: 800, height: 600, scale: 1, offsetX: 400, offsetY: 300,
    focusId: null, neighbors: null, text: '#aaa', textStrong: '#fff', background: '#000', maxChars: 16,
    ...overrides,
  })
  return drawn
}
const node = (id: string, x = 0) => ({ id, label: id, x, y: 0, radius: 5 })

describe('graph label decluttering', () => {
  it('reserves space for the hovered label before overlapping hubs', () => {
    expect(render([{ ...node('hub'), degree: 100 }, node('hover')], { focusId: 'hover' })).toEqual(['hover'])
  })
  it('reveals labels as zoom creates more screen space', () => {
    const nodes = [node('first'), node('second', 40)]
    expect(render(nodes)).toHaveLength(1)
    expect(render(nodes, { scale: 2 })).toHaveLength(2)
  })
  it('keeps focused titles visible when zoomed out and omits offscreen nodes', () => {
    expect(render([node('focus'), node('other', 200)], { scale: 0.25, focusId: 'focus' })).toEqual(['focus'])
    expect(render([node('outside', 1000)])).toEqual([])
  })
  it('shows full focused names and preserves the current page during neighbor filtering', () => {
    const title = 'a focused title longer than sixteen characters'
    expect(render([node(title)], { focusId: title })).toEqual([title])
    expect(render([{ ...node('current'), current: true }, node('hidden', 200)], { neighbors: new Set() })).toEqual(['current'])
  })
})
