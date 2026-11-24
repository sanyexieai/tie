/**
 * 每个存储位置都是同一棵工作区目录。用户只感知保存；对齐见 docs/sync.md。
 * 本地/SMB 是工作副本，Git remote 传树；后台（磁盘|S3）经 API，不是独立页面模型。
 */

export const WORKSPACE_TREE_DIRS = ['pages', '.tie'] as const

const PAGE_ID = /^pg_[A-Za-z0-9_-]{8,64}$/

export function workspacePagePath(pageId: string) {
  const id = pageId.trim()
  if (!PAGE_ID.test(id)) throw new Error(`页面 id 无效：${pageId}`)
  return `pages/${id}.md`
}

export function workspaceHistoryDir(pageId: string) {
  const id = pageId.trim()
  if (!PAGE_ID.test(id)) throw new Error(`页面 id 无效：${pageId}`)
  return `.tie/history/${id}`
}

export function workspaceAssetPath(pageId: string, fileName: string) {
  const id = pageId.trim()
  const name = fileName.trim()
  if (!PAGE_ID.test(id)) throw new Error(`页面 id 无效：${pageId}`)
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`附件名无效：${fileName}`)
  }
  return `.tie/assets/${id}/${name}`
}

/** Git 跟踪的工作区内容。连接配置留在本机，不进提交。 */
export const GIT_TRACKED_PATHS = ['pages', '.tie'] as const

export const GIT_SYNC_CONFIG = '.tie/sync.json'
