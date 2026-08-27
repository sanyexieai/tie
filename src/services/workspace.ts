import { invoke } from '@tauri-apps/api/core'
import type { Page, PageId, Workspace, WorkspaceSnapshot } from '@/types'

const fallbackKey = 'tie-demo-workspace-v1'

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function now() { return new Date().toISOString() }

function initialSnapshot(): WorkspaceSnapshot {
  const createdAt = now()
  const root = id('pg')
  const welcome = id('pg')
  return {
    workspace: { id: 'local-demo', name: '我的知识库', path: '浏览器演示工作区' },
    pages: [
      { id: root, title: '收集箱', parentId: null, sortKey: 0, markdown: '# 收集箱\n\n把想法先放在这里，再慢慢整理。\n\n- 输入 `[[` 可以关联页面\n- 点击左侧的 + 创建子页面', tags: ['收集'], createdAt, updatedAt: createdAt, deletedAt: null },
      { id: welcome, title: '欢迎使用 Tie', parentId: root, sortKey: 0, markdown: '# 欢迎使用 Tie\n\nTie 把 **Notion 的页面树**、**Typora 的写作感** 和 **Obsidian 的链接关系** 放在一起。\n\n## 从这里开始\n\n1. 在左侧创建页面或子页面\n2. 直接用 Markdown 写作\n3. 用标签与链接整理知识', tags: ['开始'], createdAt, updatedAt: createdAt, deletedAt: null },
    ],
  }
}

function localSnapshot(): WorkspaceSnapshot {
  const raw = localStorage.getItem(fallbackKey)
  if (!raw) {
    const snapshot = initialSnapshot()
    localStorage.setItem(fallbackKey, JSON.stringify(snapshot))
    return snapshot
  }
  return JSON.parse(raw) as WorkspaceSnapshot
}

function saveLocal(snapshot: WorkspaceSnapshot) {
  localStorage.setItem(fallbackKey, JSON.stringify(snapshot))
}

async function isTauri() { return '__TAURI_INTERNALS__' in window }

export const workspaceService = {
  async load(): Promise<WorkspaceSnapshot> {
    if (await isTauri()) return invoke<WorkspaceSnapshot>('load_workspace')
    return localSnapshot()
  },
  async savePage(page: Page) {
    if (await isTauri()) return invoke<Page>('save_page', { page })
    const snapshot = localSnapshot()
    const index = snapshot.pages.findIndex((candidate) => candidate.id === page.id)
    if (index === -1) snapshot.pages.push(page)
    else snapshot.pages[index] = page
    saveLocal(snapshot)
    return page
  },
  async createPage(parentId: PageId | null): Promise<Page> {
    const snapshot = await this.load()
    const page: Page = {
      id: id('pg'),
      title: '无标题',
      parentId,
      sortKey: snapshot.pages.filter((item) => item.parentId === parentId).length,
      markdown: '# 无标题\n\n',
      tags: [],
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
    }
    return this.savePage(page)
  },
  async updateWorkspace(workspace: Workspace) {
    if (await isTauri()) return invoke<Workspace>('update_workspace', { workspace })
    const snapshot = localSnapshot()
    snapshot.workspace = workspace
    saveLocal(snapshot)
    return workspace
  },
}
