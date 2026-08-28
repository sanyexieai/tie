import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { backendService, isBackendSourceId, parseBackendWorkspaceId } from '@/services/backend'
import { isS3SourceId, loadLocalS3Providers, providerForS3Source, s3SourceId } from '@/services/s3'
import type { Page, PageId, PageRevision, StorageKind, WorkspacePreferences, WorkspaceSnapshot } from '@/types'

const fallbackKey = 'tie-demo-workspace-v1'
const historyKey = 'tie-demo-page-history-v1'
const preferencesPrefix = 'tie-workspace-preferences-v1:'

interface LocalPageRevision {
  id: string
  page: Page
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function now() { return new Date().toISOString() }

function exportFilename(title: string) {
  const safe = title.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || '无标题'
  return `${safe}.md`
}

function initialSnapshot(): WorkspaceSnapshot {
  const createdAt = now()
  const root = id('pg')
  const welcome = id('pg')
  const sourceId = 'source-demo-local'
  return {
    workspace: { id: 'local-demo', name: '我的知识库', sources: [{ id: sourceId, name: '浏览器演示工作区', path: 'localStorage', kind: 'local', available: true }] },
    pages: [
      { id: root, title: '收集箱', icon: '📥', parentId: null, sortKey: 0, markdown: '# 收集箱\n\n把想法先放在这里，再慢慢整理。\n\n- 输入 `[[` 可以关联页面\n- 点击左侧的 + 创建子页面', tags: ['收集'], createdAt, updatedAt: createdAt, deletedAt: null, storageSourceId: sourceId },
      { id: welcome, title: '欢迎使用 Tie', icon: '👋', parentId: root, sortKey: 0, markdown: '# 欢迎使用 Tie\n\nTie 把 **Notion 的页面树**、**Typora 的写作感** 和 **Obsidian 的链接关系** 放在一起。\n\n## 从这里开始\n\n1. 在左侧创建页面或子页面\n2. 直接用 Markdown 写作\n3. 用标签与链接整理知识', tags: ['开始'], createdAt, updatedAt: createdAt, deletedAt: null, storageSourceId: sourceId },
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
  const snapshot = JSON.parse(raw) as WorkspaceSnapshot
  if (!snapshot.workspace.sources) {
    const sourceId = 'source-demo-local'
    snapshot.workspace.sources = [{ id: sourceId, name: '浏览器演示工作区', path: 'localStorage', kind: 'local', available: true }]
    snapshot.pages.forEach((page) => { page.storageSourceId ??= sourceId })
  }
  snapshot.pages.forEach((page) => { page.icon ??= '' })
  snapshot.workspace.sources.forEach((source) => { source.available ??= true })
  return snapshot
}

function saveLocal(snapshot: WorkspaceSnapshot) {
  localStorage.setItem(fallbackKey, JSON.stringify(snapshot))
}

function localHistory(): Record<PageId, LocalPageRevision[]> {
  try {
    const raw = localStorage.getItem(historyKey)
    return raw ? JSON.parse(raw) as Record<PageId, LocalPageRevision[]> : {}
  } catch { return {} }
}

function saveLocalHistory(history: Record<PageId, LocalPageRevision[]>) {
  localStorage.setItem(historyKey, JSON.stringify(history))
}

function pageHasChanged(before: Page, after: Page) {
  return before.title !== after.title
    || before.icon !== after.icon
    || before.parentId !== after.parentId
    || before.sortKey !== after.sortKey
    || before.markdown !== after.markdown
    || before.tags.join('\u0000') !== after.tags.join('\u0000')
    || before.deletedAt !== after.deletedAt
    || before.storageSourceId !== after.storageSourceId
}

function archiveLocalRevision(page: Page) {
  const history = localHistory()
  const revisions = history[page.id] ?? []
  history[page.id] = [{ id: id('rev'), page }, ...revisions].slice(0, 80)
  saveLocalHistory(history)
}

function preferencesKey(workspaceId: string) { return `${preferencesPrefix}${workspaceId}` }

function defaultPreferences(): WorkspacePreferences {
  return { favoritePageIds: [], recentPageIds: [], collapsedPageIds: [], spellcheckEnabled: true, sourceMode: false, storageSourceOrder: [] }
}

async function isTauri() { return '__TAURI_INTERNALS__' in window }

async function loadFileSnapshot(): Promise<WorkspaceSnapshot> {
  if (await isTauri()) return invoke<WorkspaceSnapshot>('load_workspace')
  return localSnapshot()
}

async function loadBackendPages() {
  const profile = backendService.loadProfile()
  return backendService.loadAllPages(profile, (workspaceId) => `backend:${workspaceId}`)
}

async function loadS3Pages() {
  if (!(await isTauri())) return []
  const providers = loadLocalS3Providers().filter((provider) => provider.credentialStored)
  const pages = await Promise.all(providers.map(async (provider) => {
    try {
      return await invoke<Page[]>('load_s3_pages', {
        connection: { providerId: provider.id, endpoint: provider.endpoint, bucket: provider.bucket },
      })
    } catch {
      return [] as Page[]
    }
  }))
  return pages.flat()
}

async function mergeSnapshot(fileSnapshot: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
  const filePages = fileSnapshot.pages.filter((page) => !isBackendSourceId(page.storageSourceId))
  const [backendPages, s3Pages] = await Promise.all([loadBackendPages(), loadS3Pages()])
  return { workspace: fileSnapshot.workspace, pages: [...filePages, ...backendPages, ...s3Pages] }
}

export const workspaceService = {
  async load(): Promise<WorkspaceSnapshot> {
    return mergeSnapshot(await loadFileSnapshot())
  },
  async savePage(page: Page, expectedUpdatedAt?: string) {
    if (isBackendSourceId(page.storageSourceId)) {
      const profile = backendService.loadProfile()
      if (!profile.accessToken) throw new Error('请先连接自定义后台')
      return backendService.savePage(profile, parseBackendWorkspaceId(page.storageSourceId), page, expectedUpdatedAt)
    }
    if (isS3SourceId(page.storageSourceId)) {
      if (!(await isTauri())) throw new Error('S3 页面仅支持桌面端')
      const provider = providerForS3Source(page.storageSourceId)
      if (!provider?.credentialStored) throw new Error('未找到 S3 本机密钥，请重新保存该连接')
      return invoke<Page>('save_s3_page', {
        connection: { providerId: provider.id, endpoint: provider.endpoint, bucket: provider.bucket },
        page: { ...page, storageSourceId: s3SourceId(provider.id) },
      })
    }
    if (await isTauri()) return invoke<Page>('save_page', { page })
    const snapshot = localSnapshot()
    const index = snapshot.pages.findIndex((candidate) => candidate.id === page.id)
    if (index === -1) snapshot.pages.push(page)
    else {
      const existing = snapshot.pages[index]
      if (pageHasChanged(existing, page)) archiveLocalRevision(existing)
      snapshot.pages[index] = page
    }
    saveLocal(snapshot)
    return page
  },
  async readLatestPage(page: Page): Promise<Page | null> {
    if (!isBackendSourceId(page.storageSourceId)) return null
    const profile = backendService.loadProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    const remote = await backendService.getPage(profile, parseBackendWorkspaceId(page.storageSourceId), page.id)
    return { ...remote, storageSourceId: page.storageSourceId }
  },
  async transferPage(page: Page, targetSourceId: string) {
    if (isBackendSourceId(page.storageSourceId) || isBackendSourceId(targetSourceId)) {
      throw new Error('暂不支持在自定义后台与其他存储源之间迁移页面')
    }
    if (await isTauri()) return invoke<Page>('transfer_page_storage', { page, targetSourceId })
    return this.savePage({ ...page, storageSourceId: targetSourceId })
  },
  async listPageRevisions(page: Page): Promise<PageRevision[]> {
    if (isBackendSourceId(page.storageSourceId)) {
      const profile = backendService.loadProfile()
      if (!profile.accessToken) throw new Error('请先连接自定义后台')
      return backendService.listPageRevisions(profile, parseBackendWorkspaceId(page.storageSourceId), page.id)
    }
    if (isS3SourceId(page.storageSourceId)) return []
    if (await isTauri()) return invoke<PageRevision[]>('list_page_revisions', { pageId: page.id, storageSourceId: page.storageSourceId })
    return (localHistory()[page.id] ?? []).map((revision) => ({
      id: revision.id,
      savedAt: revision.page.updatedAt,
      title: revision.page.title,
    }))
  },
  async readPageRevision(page: Page, revisionId: string): Promise<Page> {
    if (isBackendSourceId(page.storageSourceId)) {
      const profile = backendService.loadProfile()
      if (!profile.accessToken) throw new Error('请先连接自定义后台')
      const revision = await backendService.readPageRevision(profile, parseBackendWorkspaceId(page.storageSourceId), page.id, revisionId)
      return { ...revision, storageSourceId: page.storageSourceId }
    }
    if (await isTauri()) return invoke<Page>('read_page_revision', { page, revisionId })
    const revision = localHistory()[page.id]?.find((candidate) => candidate.id === revisionId)
    if (!revision) throw new Error('未找到该历史版本')
    return revision.page
  },
  async restorePageRevision(page: Page, revisionId: string): Promise<Page> {
    if (isBackendSourceId(page.storageSourceId)) {
      const revision = await this.readPageRevision(page, revisionId)
      return this.savePage({ ...revision, id: page.id, storageSourceId: page.storageSourceId, createdAt: page.createdAt, updatedAt: now() })
    }
    const updated = { ...page, updatedAt: now() }
    if (await isTauri()) return invoke<Page>('restore_page_revision', { page: updated, revisionId })
    const revision = localHistory()[page.id]?.find((candidate) => candidate.id === revisionId)
    if (!revision) throw new Error('未找到该历史版本')
    return this.savePage({
      ...revision.page,
      id: page.id,
      storageSourceId: page.storageSourceId,
      createdAt: page.createdAt,
      updatedAt: now(),
    })
  },
  async exportPageMarkdown(page: Page): Promise<boolean> {
    const filename = exportFilename(page.title)
    if (await isTauri()) {
      const targetPath = await save({
        title: '导出 Markdown 页面',
        defaultPath: filename,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (!targetPath) return false
      await invoke('export_page_markdown', { page, targetPath })
      return true
    }
    const blob = new Blob([page.markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    return true
  },
  async permanentlyDeletePages(pages: Page[]) {
    const backendPages = pages.filter((page) => isBackendSourceId(page.storageSourceId))
    const s3Pages = pages.filter((page) => isS3SourceId(page.storageSourceId))
    const filePages = pages.filter((page) => !isBackendSourceId(page.storageSourceId) && !isS3SourceId(page.storageSourceId))
    if (backendPages.length) {
      const profile = backendService.loadProfile()
      if (!profile.accessToken) throw new Error('请先连接自定义后台')
      const grouped = new Map<string, string[]>()
      backendPages.forEach((page) => {
        const workspaceId = parseBackendWorkspaceId(page.storageSourceId)
        const ids = grouped.get(workspaceId) ?? []
        ids.push(page.id)
        grouped.set(workspaceId, ids)
      })
      for (const [workspaceId, pageIds] of grouped) {
        await backendService.deletePages(profile, workspaceId, pageIds)
      }
    }
    if (s3Pages.length) {
      if (!(await isTauri())) throw new Error('S3 页面仅支持桌面端')
      const groups = new Map<string, string[]>()
      s3Pages.forEach((page) => {
        const pageIds = groups.get(page.storageSourceId) ?? []
        pageIds.push(page.id)
        groups.set(page.storageSourceId, pageIds)
      })
      for (const [sourceId, pageIds] of groups) {
        const provider = providerForS3Source(sourceId)
        if (!provider?.credentialStored) throw new Error('未找到 S3 本机密钥，请重新保存该连接')
        await invoke('permanently_delete_s3_pages', {
          connection: { providerId: provider.id, endpoint: provider.endpoint, bucket: provider.bucket },
          pageIds,
        })
      }
    }
    if (!filePages.length) return
    if (await isTauri()) {
      await invoke('permanently_delete_pages', { pages: filePages })
      return
    }
    const pageIds = new Set(filePages.map((page) => page.id))
    const snapshot = localSnapshot()
    snapshot.pages = snapshot.pages.filter((page) => !pageIds.has(page.id))
    saveLocal(snapshot)
    const history = localHistory()
    pageIds.forEach((pageId) => { delete history[pageId] })
    saveLocalHistory(history)
  },
  async createPage(parentId: PageId | null, storageSourceId: string): Promise<Page> {
    const snapshot = await this.load()
    const page: Page = {
      id: id('pg'),
      title: '无标题',
      icon: '',
      parentId,
      sortKey: snapshot.pages.filter((item) => item.parentId === parentId).length,
      markdown: '# 无标题\n\n',
      tags: [],
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
      storageSourceId,
    }
    return this.savePage(page)
  },
  async renameWorkspace(name: string): Promise<WorkspaceSnapshot> {
    if (await isTauri()) return invoke<WorkspaceSnapshot>('rename_workspace', { name })
    const snapshot = localSnapshot()
    snapshot.workspace.name = name.trim()
    saveLocal(snapshot)
    return snapshot
  },
  async addStorageSource(kind: StorageKind = 'local'): Promise<WorkspaceSnapshot | null> {
    if (!await isTauri()) return null
    const selected = await open({ directory: true, multiple: false, title: kind === 'smb' ? '选择已挂载的 SMB 知识库目录' : '选择本地知识库目录' })
    if (typeof selected !== 'string') return null
    return invoke<WorkspaceSnapshot>('add_storage_source', { path: selected, kind })
  },
  async importMarkdownFiles(targetSourceId: string): Promise<WorkspaceSnapshot | null> {
    if (!await isTauri()) return null
    const selected = await open({ multiple: true, title: '选择要导入的 Markdown 文件', filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] })
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : []
    if (!paths.length) return null
    return invoke<WorkspaceSnapshot>('import_markdown_files', { paths, targetSourceId, createdAt: now() })
  },
  async removeStorageSource(sourceId: string): Promise<WorkspaceSnapshot | null> {
    if (!await isTauri()) return null
    return invoke<WorkspaceSnapshot>('remove_storage_source', { sourceId })
  },
  async renameStorageSource(sourceId: string, name: string): Promise<WorkspaceSnapshot> {
    if (await isTauri()) return invoke<WorkspaceSnapshot>('rename_storage_source', { sourceId, name })
    const snapshot = localSnapshot()
    const source = snapshot.workspace.sources.find((item) => item.id === sourceId)
    if (!source) throw new Error('存储源不存在')
    source.name = name.trim()
    saveLocal(snapshot)
    return snapshot
  },
  loadPreferences(workspaceId: string): WorkspacePreferences {
    try {
      const raw = localStorage.getItem(preferencesKey(workspaceId))
      if (!raw) return defaultPreferences()
      const parsed = JSON.parse(raw) as Partial<WorkspacePreferences>
      return {
        favoritePageIds: Array.isArray(parsed.favoritePageIds) ? parsed.favoritePageIds : [],
        recentPageIds: Array.isArray(parsed.recentPageIds) ? parsed.recentPageIds : [],
        collapsedPageIds: Array.isArray(parsed.collapsedPageIds) ? parsed.collapsedPageIds : [],
        spellcheckEnabled: typeof parsed.spellcheckEnabled === 'boolean' ? parsed.spellcheckEnabled : true,
        sourceMode: typeof parsed.sourceMode === 'boolean' ? parsed.sourceMode : false,
        storageSourceOrder: Array.isArray(parsed.storageSourceOrder) ? parsed.storageSourceOrder.filter((id): id is string => typeof id === 'string') : [],
      }
    } catch { return defaultPreferences() }
  },
  savePreferences(workspaceId: string, preferences: WorkspacePreferences) {
    localStorage.setItem(preferencesKey(workspaceId), JSON.stringify(preferences))
  },
}
