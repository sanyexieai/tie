import type { Page } from '@/types'
import { backendService, backendWorkspaceSource, type BackendProfile } from '@/services/backend'
import { normalizePageSources } from '@/services/page-sources'
import type { WorkspaceSnapshot } from '@/types'

const fallbackKey = 'tie-demo-workspace-v1'

export function isStockWelcomePage(page: Pick<Page, 'title' | 'markdown'>) {
  return page.title === '欢迎使用 Tie' && page.markdown.startsWith('# 欢迎使用 Tie\n')
}

export function temporaryBrowserPages(): Page[] {
  if (typeof localStorage === 'undefined') return []
  const raw = localStorage.getItem(fallbackKey)
  if (!raw) return []
  try {
    const snapshot = JSON.parse(raw) as { pages?: Page[] }
    return (snapshot.pages ?? []).filter((page) => !page.deletedAt && !isStockWelcomePage(page))
  } catch {
    return []
  }
}

export function clearTemporaryBrowserPages() {
  if (typeof localStorage === 'undefined') return
  const raw = localStorage.getItem(fallbackKey)
  if (!raw) return
  try {
    const snapshot = JSON.parse(raw) as { pages?: Page[] }
    snapshot.pages = (snapshot.pages ?? []).filter((page) => isStockWelcomePage(page))
    localStorage.setItem(fallbackKey, JSON.stringify(snapshot))
  } catch {
    localStorage.removeItem(fallbackKey)
  }
}

export function pickAccountWorkspace<T extends { id: string; name: string; default?: boolean }>(workspaces: T[]) {
  return workspaces.find((item) => item.default)
    ?? workspaces.find((item) => item.name === '我的工作区')
    ?? workspaces[0]
    ?? null
}

export async function loadBackendDocumentSnapshot(profile: BackendProfile): Promise<WorkspaceSnapshot> {
  const workspaces = await backendService.listWorkspaces(profile)
  const target = pickAccountWorkspace(workspaces)
  if (!target) {
    return { workspace: { id: 'backend-empty', name: '后台', sources: [] }, pages: [] }
  }
  const source = backendWorkspaceSource(target, profile.endpoint)
  const pages = await backendService.listPages(profile, target.id)
  return {
    workspace: { id: target.id, name: target.name, sources: [source] },
    pages: pages.map((page) => normalizePageSources({
      ...page,
      storageSourceId: source.id,
      storageSourceIds: [source.id],
    })),
  }
}

export async function pushTemporaryBrowserPages(pages: Page[]) {
  const profile = backendService.loadProfile()
  if (!profile.accessToken) throw new Error('请先登录')
  const workspaces = await backendService.listWorkspaces(profile)
  const target = pickAccountWorkspace(workspaces)
  if (!target) throw new Error('后台还没有工作区')
  const sourceId = `backend:${target.id}`
  for (const page of pages) {
    await backendService.savePage(profile, target.id, {
      ...page,
      storageSourceId: sourceId,
      storageSourceIds: [sourceId],
    })
  }
}
