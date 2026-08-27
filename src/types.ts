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
}

export interface Workspace {
  id: string
  name: string
  path: string
}

export interface PageTreeNode extends Page {
  children: PageTreeNode[]
}

export interface WorkspaceSnapshot {
  workspace: Workspace
  pages: Page[]
}

