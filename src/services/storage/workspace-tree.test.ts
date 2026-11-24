import { describe, expect, it } from 'vitest'
import {
  GIT_SYNC_CONFIG,
  GIT_TRACKED_PATHS,
  workspaceAssetPath,
  workspaceHistoryDir,
  workspacePagePath,
} from '@/services/storage/workspace-tree'

describe('workspace-tree', () => {
  it('maps a page onto the shared directory layout', () => {
    expect(workspacePagePath('pg_0123456789abcdef')).toBe('pages/pg_0123456789abcdef.md')
    expect(workspaceHistoryDir('pg_0123456789abcdef')).toBe('.tie/history/pg_0123456789abcdef')
    expect(workspaceAssetPath('pg_0123456789abcdef', 'a.png')).toBe('.tie/assets/pg_0123456789abcdef/a.png')
  })

  it('rejects path segments in ids and file names', () => {
    expect(() => workspacePagePath('../pg_0123456789abcdef')).toThrow(/无效/)
    expect(() => workspaceAssetPath('pg_0123456789abcdef', '../secret')).toThrow(/无效/)
  })

  it('tracks the tree and keeps the git remote config local', () => {
    expect(GIT_TRACKED_PATHS).toEqual(['pages', '.tie'])
    expect(GIT_SYNC_CONFIG).toBe('.tie/sync.json')
  })
})
