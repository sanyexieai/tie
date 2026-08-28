import fs from 'node:fs'
import path from 'node:path'
import { frontmatter, parsePage, revisionId } from './page-format.js'
import { store } from './store.js'
import { deleteWorkspacePageAssets } from './workspace-assets.js'

const MAX_REVISIONS = 80

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => path.join(dir, name))
}

export function listWorkspacePages(workspaceId, sourceId) {
  const dir = store.workspacePagesDir(workspaceId)
  return listMarkdownFiles(dir).map((filePath) => {
    const page = parsePage(fs.readFileSync(filePath, 'utf8'))
    return { ...page, storageSourceId: sourceId ?? page.storageSourceId ?? `backend:${workspaceId}` }
  })
}

export function getWorkspacePage(workspaceId, pageId, sourceId) {
  const filePath = path.join(store.workspacePagesDir(workspaceId), `${pageId}.md`)
  if (!fs.existsSync(filePath)) throw new Error('页面不存在')
  const page = parsePage(fs.readFileSync(filePath, 'utf8'))
  return { ...page, storageSourceId: sourceId ?? page.storageSourceId ?? `backend:${workspaceId}` }
}

export function saveWorkspacePage(workspaceId, page, expectedUpdatedAt) {
  const filePath = path.join(store.workspacePagesDir(workspaceId), `${page.id}.md`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (expectedUpdatedAt && fs.existsSync(filePath)) {
    const current = parsePage(fs.readFileSync(filePath, 'utf8'))
    if (current.updatedAt !== expectedUpdatedAt) {
      const error = new Error('页面已在其他设备更新，请重新载入后再保存')
      error.status = 409
      throw error
    }
    if (current.markdown !== page.markdown || current.title !== page.title) {
      archiveWorkspaceRevision(workspaceId, current)
    }
  }
  const next = { ...page, updatedAt: page.updatedAt || new Date().toISOString() }
  fs.writeFileSync(filePath, frontmatter(next))
  return next
}

export function deleteWorkspacePages(workspaceId, pageIds) {
  for (const pageId of pageIds) {
    const filePath = path.join(store.workspacePagesDir(workspaceId), `${pageId}.md`)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    const historyDir = store.workspaceHistoryDir(workspaceId, pageId)
    if (fs.existsSync(historyDir)) fs.rmSync(historyDir, { recursive: true, force: true })
    deleteWorkspacePageAssets(workspaceId, pageId)
  }
}

function archiveWorkspaceRevision(workspaceId, page) {
  const dir = store.workspaceHistoryDir(workspaceId, page.id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${revisionId()}.md`), frontmatter(page))
  const files = listMarkdownFiles(dir).sort()
  while (files.length > MAX_REVISIONS) {
    fs.unlinkSync(files.shift())
  }
}

export function listWorkspaceRevisions(workspaceId, pageId) {
  const dir = store.workspaceHistoryDir(workspaceId, pageId)
  return listMarkdownFiles(dir).map((filePath) => {
    const page = parsePage(fs.readFileSync(filePath, 'utf8'))
    return { id: path.basename(filePath, '.md'), savedAt: page.updatedAt, title: page.title }
  }).sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

export function readWorkspaceRevision(workspaceId, pageId, revisionIdValue, sourceId) {
  const filePath = path.join(store.workspaceHistoryDir(workspaceId, pageId), `${revisionIdValue}.md`)
  if (!fs.existsSync(filePath)) throw new Error('历史版本不存在')
  const page = parsePage(fs.readFileSync(filePath, 'utf8'))
  return { ...page, storageSourceId: sourceId ?? page.storageSourceId ?? `backend:${workspaceId}` }
}
