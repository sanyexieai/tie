export type PageId = string
export type StorageKind = 'local' | 'smb'

export interface StorageSource {
  id: string
  name: string
  kind: StorageKind
  path: string
}

export interface Page {
  id: PageId
  title: string
  parentId: PageId | null
  sortKey: number
  markdown: string
  tags: string[]
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  storageSourceId: string
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

export interface SearchResult {
  page: Page
  score: number
  snippet: string
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
}
