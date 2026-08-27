export type PageId = string

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
}

export interface Workspace {
  id: string
  name: string
  path: string
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

export interface WorkspaceSnapshot {
  workspace: Workspace
  pages: Page[]
}
