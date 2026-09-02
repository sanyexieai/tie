export type PageId = string
export type StorageKind = 'local' | 'smb' | 's3' | 'backend'

export interface StorageSource {
  id: string
  name: string
  kind: StorageKind
  path: string
  available?: boolean
}

export interface Page {
  id: PageId
  title: string
  icon: string
  parentId: PageId | null
  sortKey: number
  markdown: string
  tags: string[]
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  /** 主存储源：多客户端协作的唯一真相源；日常保存只写入这里 */
  storageSourceId: string
  /** 绑定源列表（含主源）。除主源外为备份镜像，不随每次保存自动写入，需手动「同步到备份」 */
  storageSourceIds?: string[]
}

export interface Workspace {
  id: string
  name: string
  sources: StorageSource[]
}

export interface PageTreeNode extends Page {
  children: PageTreeNode[]
}

export interface PageLink {
  fromPageId: PageId
  toPageId: PageId
}

export interface PageRevision {
  id: string
  savedAt: string
  title: string
}

export interface SearchResult {
  page: Page
  score: number
  snippet: string
  sourceName: string
  sourceKind: StorageKind
}

export interface TagSummary {
  name: string
  count: number
}

export interface WorkspaceSnapshot {
  workspace: Workspace
  pages: Page[]
}

export interface WorkspacePreferences {
  favoritePageIds: PageId[]
  recentPageIds: PageId[]
  collapsedPageIds: PageId[]
  spellcheckEnabled: boolean
  sourceMode: boolean
  storageSourceOrder: string[]
  skillsSectionCollapsed: boolean
}
