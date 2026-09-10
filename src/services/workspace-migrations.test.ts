import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isWorkspaceMigrationApplied,
  MIGRATIONS_RELATIVE_PATH,
  runFileHrefMigrationOnce,
  WORKSPACE_MIGRATIONS,
} from '@/services/workspace-migrations'
import { buildPathUrl } from '@/services/local-links'

const memory = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  removeItem: (key: string) => { memory.delete(key) },
  clear: () => { memory.clear() },
})

const localSource = {
  id: 'src_local_2e27348a0aa628a6',
  name: '本机',
  kind: 'local' as const,
  path: '/tmp/ws',
  available: true,
}

describe('workspace-migrations', () => {
  beforeEach(() => {
    memory.clear()
  })

  it('runs in-workspace file href migration only once per stamp', async () => {
    const pages = [
      {
        id: 'pg_1',
        title: 't',
        icon: '',
        parentId: null,
        sortKey: 0,
        markdown: '见 [x](file:///tmp/ws/a.md)',
        tags: [],
        createdAt: '',
        updatedAt: '',
        deletedAt: null,
        storageSourceId: localSource.id,
      },
    ]
    const persisted: string[] = []
    const first = await runFileHrefMigrationOnce({
      pages,
      sources: [localSource],
      persistPage: async (page) => { persisted.push(page.markdown) },
    })
    expect(first.ran).toBe(true)
    expect(first.converted).toBe(1)
    expect(persisted[0]).toContain(buildPathUrl('a.md', localSource.id))
    expect(await isWorkspaceMigrationApplied(WORKSPACE_MIGRATIONS.fileHrefProtocol, [localSource])).toBe(true)
    expect(MIGRATIONS_RELATIVE_PATH).toBe('.tie/migrations.json')

    const second = await runFileHrefMigrationOnce({
      pages: [{ ...pages[0], markdown: '见 [x](file:///tmp/ws/b.md)' }],
      sources: [localSource],
      persistPage: async () => { throw new Error('should not persist again') },
    })
    expect(second.ran).toBe(false)
  })

  it('stamps before work and skips zone-external ingest', async () => {
    const pages = [
      {
        id: 'pg_ext',
        title: 't',
        icon: '',
        parentId: null,
        sortKey: 0,
        markdown: '见 [x](file:///home/sanye/models/registry/)',
        tags: [],
        createdAt: '',
        updatedAt: '',
        deletedAt: null,
        storageSourceId: localSource.id,
      },
    ]
    const first = await runFileHrefMigrationOnce({
      pages,
      sources: [localSource],
      persistPage: async () => { throw new Error('external should not persist') },
    })
    expect(first.ran).toBe(true)
    expect(first.converted).toBe(0)
    expect(first.skipped.length).toBe(1)
    expect(await isWorkspaceMigrationApplied(WORKSPACE_MIGRATIONS.fileHrefProtocol, [localSource])).toBe(true)

    const second = await runFileHrefMigrationOnce({
      pages,
      sources: [localSource],
      persistPage: async () => { throw new Error('should not run again') },
    })
    expect(second.ran).toBe(false)
  })
})
