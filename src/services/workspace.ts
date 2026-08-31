import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { preparePageExportBundle } from '@/services/attachments'
import { storageRegistry } from '@/services/storage/registry'
import type { SavePageOptions } from '@/services/storage/types'
import { isBackendRemoteSourceId } from '@/services/backend'
import { isS3SourceId } from '@/services/s3'
import type { Page, PageId, PageRevision, StorageKind, WorkspacePreferences, WorkspaceSnapshot } from '@/types'

const fallbackKey = 'tie-demo-workspace-v1'
const preferencesPrefix = 'tie-workspace-preferences-v1:'

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

function preferencesKey(workspaceId: string) { return `${preferencesPrefix}${workspaceId}` }

function defaultPreferences(): WorkspacePreferences {
  return { favoritePageIds: [], recentPageIds: [], collapsedPageIds: [], spellcheckEnabled: true, sourceMode: false, storageSourceOrder: [], skillsSectionCollapsed: true }
}

async function isTauri() { return '__TAURI_INTERNALS__' in window }

async function loadFileSnapshot(): Promise<WorkspaceSnapshot> {
  if (await isTauri()) return invoke<WorkspaceSnapshot>('load_workspace')
  return localSnapshot()
}

export const workspaceService = {
  async loadLocal(): Promise<WorkspaceSnapshot> {
    return storageRegistry.mergeSnapshot(await loadFileSnapshot(), undefined, { remote: false })
  },
  async load(contextPages?: Page[]): Promise<WorkspaceSnapshot> {
    return storageRegistry.mergeSnapshot(await loadFileSnapshot(), contextPages)
  },
  async loadWithSync(contextPages: Page[] = []) {
    const fileSnapshot = await loadFileSnapshot()
    const remote = await storageRegistry.loadRemotePages(contextPages)
    const merged = await storageRegistry.mergeSnapshot(fileSnapshot, contextPages, { remote: false })
    return {
      snapshot: { workspace: merged.workspace, pages: [...merged.pages, ...remote.pages] },
      syncResults: remote.syncResults,
    }
  },
  async savePage(page: Page, options?: Pick<SavePageOptions, 'expectedUpdatedAt' | 'force'>) {
    return storageRegistry.savePage(page, { ...options, queueOnFailure: true })
  },
  async readLatestPage(page: Page): Promise<Page | null> {
    return storageRegistry.readLatestPage(page)
  },
  async transferPage(page: Page, targetSourceId: string) {
    return storageRegistry.transferPage(page, targetSourceId)
  },
  async listPageRevisions(page: Page): Promise<PageRevision[]> {
    return storageRegistry.listPageRevisions(page)
  },
  async readPageRevision(page: Page, revisionId: string): Promise<Page> {
    return storageRegistry.readPageRevision(page, revisionId)
  },
  async restorePageRevision(page: Page, revisionId: string): Promise<Page> {
    if (isBackendRemoteSourceId(page.storageSourceId)) {
      const revision = await this.readPageRevision(page, revisionId)
      return this.savePage({ ...revision, id: page.id, storageSourceId: page.storageSourceId, createdAt: page.createdAt, updatedAt: now() })
    }
    if (isS3SourceId(page.storageSourceId)) {
      const revision = await this.readPageRevision(page, revisionId)
      return this.savePage({
        ...revision,
        id: page.id,
        storageSourceId: page.storageSourceId,
        createdAt: page.createdAt,
        updatedAt: now(),
      })
    }
    const updated = { ...page, updatedAt: now() }
    if (await isTauri()) return invoke<Page>('restore_page_revision', { page: updated, revisionId })
    return this.savePage({
      ...(await this.readPageRevision(page, revisionId)),
      id: page.id,
      storageSourceId: page.storageSourceId,
      createdAt: page.createdAt,
      updatedAt: now(),
    })
  },
  async exportPageMarkdown(page: Page): Promise<boolean> {
    const filename = exportFilename(page.title)
    const bundle = await preparePageExportBundle(page).catch(() => ({
      markdown: page.markdown,
      assets: {} as Record<string, Uint8Array>,
    }))
    const assetEntries = Object.entries(bundle.assets)

    if (await isTauri()) {
      const targetPath = await save({
        title: assetEntries.length > 0 ? '导出 Markdown 页面（含附件）' : '导出 Markdown 页面',
        defaultPath: filename,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (!targetPath) return false
      await invoke('export_page_markdown_bundle', {
        markdown: bundle.markdown,
        targetPath,
        assets: assetEntries.map(([name, data]) => ({ name, data: [...data] })),
      })
      return true
    }

    if (assetEntries.length > 0) {
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      zip.file(filename, bundle.markdown)
      const assetsFolder = zip.folder('assets')
      if (!assetsFolder) throw new Error('无法创建导出压缩包')
      for (const [name, data] of assetEntries) assetsFolder.file(name, data)
      const blob = await zip.generateAsync({ type: 'blob' })
      const zipName = filename.replace(/\.md$/i, '.zip')
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = zipName
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      return true
    }

    const blob = new Blob([bundle.markdown], { type: 'text/markdown;charset=utf-8' })
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
    await storageRegistry.permanentlyDeletePages(pages)
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
    localStorage.setItem(fallbackKey, JSON.stringify(snapshot))
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
    if (isS3SourceId(sourceId)) {
      await storageRegistry.removeSource(sourceId)
      return this.load()
    }
    if (!await isTauri()) return null
    return invoke<WorkspaceSnapshot>('remove_storage_source', { sourceId })
  },
  async renameStorageSource(sourceId: string, name: string): Promise<WorkspaceSnapshot> {
    if (isS3SourceId(sourceId)) {
      await storageRegistry.renameSource(sourceId, name)
      return this.load()
    }
    if (await isTauri()) return invoke<WorkspaceSnapshot>('rename_storage_source', { sourceId, name })
    await storageRegistry.renameSource(sourceId, name)
    return localSnapshot()
  },
  async syncSource(sourceId: string, localPages?: Page[]) {
    return storageRegistry.syncSource(sourceId, localPages)
  },
  async flushSyncQueue() {
    return storageRegistry.flushSyncQueue()
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
        skillsSectionCollapsed: typeof parsed.skillsSectionCollapsed === 'boolean' ? parsed.skillsSectionCollapsed : true,
      }
    } catch { return defaultPreferences() }
  },
  savePreferences(workspaceId: string, preferences: WorkspacePreferences) {
    localStorage.setItem(preferencesKey(workspaceId), JSON.stringify(preferences))
  },
}
