import { describe, expect, it, vi } from 'vitest'
import { isStockWelcomePage, temporaryBrowserPages } from './browser-backend'

describe('temporaryBrowserPages', () => {
  it('ignores the stock welcome page and deleted pages', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    })
    store.set('tie-demo-workspace-v1', JSON.stringify({
      pages: [
        { id: 'welcome', title: '欢迎使用 Tie', markdown: '# 欢迎使用 Tie\n\nhello', deletedAt: null },
        { id: 'note', title: '临时笔记', markdown: '正文', deletedAt: null },
        { id: 'gone', title: '已删', markdown: 'x', deletedAt: '2026-01-01T00:00:00.000Z' },
      ],
    }))
    expect(isStockWelcomePage({ title: '欢迎使用 Tie', markdown: '# 欢迎使用 Tie\n\nhello' })).toBe(true)
    expect(temporaryBrowserPages().map((page) => page.id)).toEqual(['note'])
  })
})
