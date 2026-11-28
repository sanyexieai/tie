import { describe, expect, it, vi } from 'vitest'
import { createPageNavigationHistory } from './navigation-history'

function setup() {
  let current: string | null = null
  const removed = new Set<string>()
  let allowed = true
  const open = vi.fn(async (pageId: string) => {
    if (!allowed) return false
    current = pageId
    history.record(pageId)
    return true
  })
  const history = createPageNavigationHistory({ current: () => current, available: (id) => !removed.has(id), open })
  return {
    history, open, removed,
    visit(pageId: string) { current = pageId; history.record(pageId) },
    current: () => current,
    allow(value: boolean) { allowed = value },
  }
}

describe('page navigation history', () => {
  it('returns through actual visits, ignores a repeated page and preserves forward history', async () => {
    const { history, visit, current } = setup()
    visit('a'); visit('b'); visit('c'); visit('c')
    expect(await history.move(-1)).toBe(true)
    expect(current()).toBe('b')
    expect(await history.move(-1)).toBe(true)
    expect(current()).toBe('a')
    expect(await history.move(-1)).toBe(false)
    expect(await history.move(1)).toBe(true)
    expect(current()).toBe('b')
    expect(await history.move(1)).toBe(true)
    expect(current()).toBe('c')
    expect(await history.move(1)).toBe(false)
  })

  it('discards forward visits after opening a different page', async () => {
    const { history, visit, current } = setup()
    visit('a'); visit('b'); visit('c')
    await history.move(-1)
    visit('d')
    expect(await history.move(1)).toBe(false)
    expect(await history.move(-1)).toBe(true)
    expect(current()).toBe('b')
  })

  it('does not consume a return when the editor refuses to leave, or navigation rejects', async () => {
    const { history, visit, current, allow, open } = setup()
    visit('a'); visit('b')
    allow(false)
    expect(await history.move(-1)).toBe(false)
    expect(current()).toBe('b')
    open.mockRejectedValueOnce(new Error('save failed'))
    expect(await history.move(-1)).toBe(false)
    allow(true)
    expect(await history.move(-1)).toBe(true)
    expect(current()).toBe('a')
  })

  it('skips removed or closed pages and resets between workspaces', async () => {
    const { history, visit, current, removed } = setup()
    visit('a'); visit('b'); visit('c')
    removed.add('b')
    expect(await history.move(-1)).toBe(true)
    expect(current()).toBe('a')
    history.reset('new-workspace-page')
    expect(await history.move(-1)).toBe(false)
    visit('next')
    expect(await history.move(-1)).toBe(true)
    expect(current()).toBe('new-workspace-page')
  })

  it('does not dispatch another history step while a save is pending', async () => {
    let current = 'c'
    let finish!: () => void
    const ready = new Promise<void>((resolve) => { finish = resolve })
    const open = vi.fn(async (id: string) => { await ready; current = id; history.record(id); return true })
    const history = createPageNavigationHistory({ current: () => current, available: () => true, open })
    history.record('a'); history.record('b'); history.record('c')
    const first = history.move(-1)
    expect(await history.move(-1)).toBe(false)
    expect(open).toHaveBeenCalledTimes(1)
    finish()
    expect(await first).toBe(true)
    expect(current).toBe('b')
    expect(await history.move(-1)).toBe(true)
    expect(current).toBe('a')
  })
})
