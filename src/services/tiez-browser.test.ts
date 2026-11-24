import { describe, expect, it } from 'vitest'
import { packPagesToTiez, unpackTiezBytes } from '@/services/tiez-browser'
import type { Page } from '@/types'

function samplePage(id: string, title: string): Page {
  const now = '2026-01-01T00:00:00.000Z'
  return {
    id,
    title,
    icon: '',
    parentId: null,
    sortKey: 0,
    markdown: `# ${title}\n\nhello`,
    tags: ['demo'],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    storageSourceId: 'source-demo-local',
    storageSourceIds: ['source-demo-local'],
  }
}

describe('tiez-browser', () => {
  it('packs and unpacks pages', async () => {
    const packed = packPagesToTiez([samplePage('pg_aaaaaaaaaaaaaaaa', 'Hello')], { name: 'Demo' })
    const bytes = new Uint8Array(await packed.blob.arrayBuffer())
    const result = unpackTiezBytes(bytes)
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0].title).toBe('Hello')
    expect(result.pages[0].markdown).toBe('# Hello\n\nhello')
    expect(result.pages[0].tags).toEqual(['demo'])
    expect(result.solutionName).toBe('Demo')
  })
})
