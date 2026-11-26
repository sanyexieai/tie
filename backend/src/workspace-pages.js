import fs from 'node:fs'
import path from 'node:path'
import { frontmatter, isTieDocument, parsePage, revisionId } from './page-format.js'
import { filenameStem, repairUtf8Mojibake } from './page-names.js'
import { syncRootTieFiles } from './solution-files.js'
import { notifyWorkspace } from './live.js'
import { store } from './store.js'
import { deleteWorkspacePageAssets } from './workspace-assets.js'
import { recordPageChange } from './reviews.js'

const MAX_REVISIONS = 80

function safePageId(pageId) {
  return typeof pageId === 'string'
    && pageId.length > 0
    && pageId.length <= 80
    && /^[A-Za-z0-9_-]+$/.test(pageId)
}

function workspaceLabel(workspaceId) {
  return store.loadWorkspaces().find((item) => item.id === workspaceId)?.name || '我的工作区'
}

function sourceIdFor(workspaceId) {
  return `backend:${workspaceId}`
}

function listMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => path.join(dir, name))
}

function metaFile(workspaceId, pageId) {
  if (!safePageId(pageId)) return null
  return path.join(store.workspaceDir(workspaceId), '.tie', 'meta', pageId)
}

function readMeta(workspaceId, pageId) {
  const filePath = metaFile(workspaceId, pageId)
  if (!filePath || !fs.existsSync(filePath)) return null
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  const value = (key) => {
    const prefix = `${key}:`
    const line = lines.find((item) => item.startsWith(prefix))
    return line ? line.slice(prefix.length).trim() : ''
  }
  const tags = value('tags').replace(/^\[/, '').replace(/\]$/, '').split(',').map((tag) => tag.trim()).filter(Boolean)
  return {
    id: value('id') || pageId,
    file: value('file'),
    parentId: value('parent_id') || null,
    sortKey: Number(value('sort_key') || 0),
    icon: value('icon'),
    title: value('title') || '无标题',
    tags,
    createdAt: value('created_at'),
    updatedAt: value('updated_at'),
    deletedAt: value('deleted_at') || null,
  }
}

function readMetaByFile(workspaceId) {
  const byFile = new Map()
  const dir = path.join(store.workspaceDir(workspaceId), '.tie', 'meta')
  if (!fs.existsSync(dir)) return byFile
  for (const name of fs.readdirSync(dir)) {
    const meta = readMeta(workspaceId, name)
    // Match readFilePage's first metadata entry when files are duplicated.
    if (meta && !byFile.has(meta.file)) byFile.set(meta.file, meta)
  }
  return byFile
}

function resolveWorkspaceFile(workspaceId, relative) {
  if (!relative || relative.includes(':')) return null
  const parts = relative.split(/[/\\]/).filter((part) => part && part !== '.')
  if (parts.some((part) => part === '..')) return null
  return path.join(store.workspaceDir(workspaceId), ...parts)
}

function headingTitle(markdown) {
  const line = String(markdown ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).find((item) => item.startsWith('# '))
  return line ? line.slice(2).trim() : ''
}

function repairPage(page) {
  const markdown = repairUtf8Mojibake(page.markdown ?? '')
  const title = repairUtf8Mojibake(page.title || headingTitle(markdown) || '无标题')
  return { ...page, markdown, title: title || '无标题' }
}

function pageFromMeta(meta, markdown) {
  const repaired = repairUtf8Mojibake(markdown)
  const title = headingTitle(repaired) || repairUtf8Mojibake(meta.title) || '无标题'
  return repairPage({
    id: meta.id,
    title,
    icon: meta.icon,
    parentId: meta.parentId,
    sortKey: meta.sortKey,
    markdown: repaired,
    tags: meta.tags,
    createdAt: meta.createdAt || new Date().toISOString(),
    updatedAt: meta.updatedAt || new Date().toISOString(),
    deletedAt: meta.deletedAt,
  })
}

function readFilePage(workspaceId, filePath, metaByFile) {
  const content = fs.readFileSync(filePath, 'utf8')
  if (isTieDocument(content)) return { page: repairPage(parsePage(content)), legacy: true, filePath }
  const relative = path.relative(store.workspaceDir(workspaceId), filePath).split(path.sep).join('/')
  if (metaByFile) {
    const meta = metaByFile.get(relative)
    return meta ? { page: pageFromMeta(meta, content), legacy: false, filePath } : null
  }
  const metaDir = path.join(store.workspaceDir(workspaceId), '.tie', 'meta')
  if (!fs.existsSync(metaDir)) return null
  for (const name of fs.readdirSync(metaDir)) {
    const meta = readMeta(workspaceId, name)
    if (meta?.file === relative) return { page: pageFromMeta(meta, content), legacy: false, filePath }
  }
  return null
}

function locatePageFile(workspaceId, pageId) {
  const meta = readMeta(workspaceId, pageId)
  if (meta?.file) {
    const resolved = resolveWorkspaceFile(workspaceId, meta.file)
    if (resolved && fs.existsSync(resolved)) return resolved
  }
  const legacy = path.join(store.workspacePagesDir(workspaceId), `${pageId}.md`)
  if (fs.existsSync(legacy)) return legacy
  const dir = store.workspacePagesDir(workspaceId)
  if (!fs.existsSync(dir)) return null
  const metaByFile = readMetaByFile(workspaceId)
  for (const filePath of listMarkdownFiles(dir)) {
    const found = readFilePage(workspaceId, filePath, metaByFile)
    if (found?.page.id === pageId) return filePath
  }
  return null
}

function allocatePageFile(workspaceId, pageId, title) {
  const dir = store.workspacePagesDir(workspaceId)
  fs.mkdirSync(dir, { recursive: true })
  const current = locatePageFile(workspaceId, pageId)
  const stem = filenameStem(title, '无标题')
  for (let n = 0; n < 10_000; n += 1) {
    const name = n === 0 ? `${stem}.md` : `${stem}-${n + 1}.md`
    const candidate = path.join(dir, name)
    const ours = current && path.resolve(current) === path.resolve(candidate)
    if (!fs.existsSync(candidate) || ours) return candidate
  }
  return path.join(dir, `${pageId}.md`)
}

function writeMeta(workspaceId, page, relativeFile) {
  const filePath = metaFile(workspaceId, page.id)
  if (!filePath) throw new Error('页面 id 无效')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const text = `tie_version: 1
id: ${page.id}
file: ${relativeFile}
parent_id: ${page.parentId ?? ''}
sort_key: ${page.sortKey ?? 0}
icon: ${String(page.icon ?? '').replace(/[\r\n]/g, '')}
title: ${String(page.title ?? '').replace(/[\r\n]/g, '')}
tags: [${(page.tags ?? []).join(', ')}]
created_at: ${page.createdAt}
updated_at: ${page.updatedAt}
deleted_at: ${page.deletedAt ?? ''}
`
  fs.writeFileSync(filePath, text)
}

function relativePagePath(workspaceId, filePath) {
  return path.relative(store.workspaceDir(workspaceId), filePath).split(path.sep).join('/')
}

function readAllPages(workspaceId) {
  const dir = store.workspacePagesDir(workspaceId)
  const pages = []
  const seen = new Set()
  const metaByFile = readMetaByFile(workspaceId)
  for (const filePath of listMarkdownFiles(dir)) {
    const found = readFilePage(workspaceId, filePath, metaByFile)
    if (!found || seen.has(found.page.id)) continue
    seen.add(found.page.id)
    pages.push(found)
  }
  return pages
}

function refreshTieFiles(workspaceId) {
  syncRootTieFiles(
    store.workspaceDir(workspaceId),
    sourceIdFor(workspaceId),
    readAllPages(workspaceId).map((item) => item.page),
    workspaceLabel(workspaceId),
  )
}

function writeStoredPage(workspaceId, page) {
  const next = repairPage({ ...page, updatedAt: page.updatedAt || new Date().toISOString() })
  const filePath = allocatePageFile(workspaceId, next.id, next.title)
  const previous = locatePageFile(workspaceId, next.id)
  fs.writeFileSync(filePath, next.markdown ?? '')
  writeMeta(workspaceId, next, relativePagePath(workspaceId, filePath))
  if (previous && path.resolve(previous) !== path.resolve(filePath) && fs.existsSync(previous)) {
    fs.rmSync(previous, { force: true })
  }
  return next
}

/** 把旧的 pages/<id>.md 头信息文件改成和本地一样的标题文件名加 .tie/meta。 */
export function migrateWorkspacePages(workspaceId) {
  const legacy = readAllPages(workspaceId).filter((item) => item.legacy)
  if (!legacy.length) return
  for (const item of legacy) writeStoredPage(workspaceId, item.page)
  refreshTieFiles(workspaceId)
}

function withSource(page, workspaceId, sourceId) {
  return { ...page, storageSourceId: sourceId ?? page.storageSourceId ?? sourceIdFor(workspaceId) }
}

export function listWorkspacePages(workspaceId, sourceId) {
  migrateWorkspacePages(workspaceId)
  refreshTieFiles(workspaceId)
  return readAllPages(workspaceId).map((item) => withSource(item.page, workspaceId, sourceId))
}

export function getWorkspacePage(workspaceId, pageId, sourceId) {
  migrateWorkspacePages(workspaceId)
  const filePath = locatePageFile(workspaceId, pageId)
  if (!filePath) throw new Error('页面不存在')
  const found = readFilePage(workspaceId, filePath)
  if (!found) throw new Error('页面不存在')
  return withSource(found.page, workspaceId, sourceId)
}

export function saveWorkspacePage(workspaceId, page, expectedUpdatedAt, context = {}) {
  migrateWorkspacePages(workspaceId)
  const currentPath = locatePageFile(workspaceId, page.id)
  let previous = null
  if (currentPath) {
    const current = readFilePage(workspaceId, currentPath)
    previous = current?.page ?? null
    if (current && expectedUpdatedAt && current.page.updatedAt !== expectedUpdatedAt) {
      const error = new Error('页面已在其他设备更新，请重新载入后再保存')
      error.status = 409
      throw error
    }
    if (current && pageHasChanged(current.page, page)) {
      archiveWorkspaceRevision(workspaceId, current.page)
    }
  }
  const saved = writeStoredPage(workspaceId, page)
  recordPageChange(workspaceId, previous, saved, context.origin, context)
  refreshTieFiles(workspaceId)
  notifyWorkspace(workspaceId)
  return saved
}

function pageHasChanged(before, after) {
  return before.title !== after.title
    || (before.markdown ?? '') !== (after.markdown ?? '')
    || (before.icon ?? '') !== (after.icon ?? '')
    || (before.parentId ?? null) !== (after.parentId ?? null)
    || (before.sortKey ?? 0) !== (after.sortKey ?? 0)
    || JSON.stringify(before.tags ?? []) !== JSON.stringify(after.tags ?? [])
    || before.createdAt !== after.createdAt
    || (before.deletedAt ?? null) !== (after.deletedAt ?? null)
}

export function deleteWorkspacePages(workspaceId, pageIds, context = {}) {
  migrateWorkspacePages(workspaceId)
  for (const pageId of pageIds) {
    const filePath = locatePageFile(workspaceId, pageId)
    const previous = filePath ? readFilePage(workspaceId, filePath)?.page : null
    if (filePath && fs.existsSync(filePath)) fs.rmSync(filePath, { force: true })
    const meta = metaFile(workspaceId, pageId)
    if (meta && fs.existsSync(meta)) fs.rmSync(meta, { force: true })
    const historyDir = store.workspaceHistoryDir(workspaceId, pageId)
    if (fs.existsSync(historyDir)) fs.rmSync(historyDir, { recursive: true, force: true })
    deleteWorkspacePageAssets(workspaceId, pageId)
    if (previous) recordPageChange(workspaceId, previous, null, context.origin, context)
  }
  refreshTieFiles(workspaceId)
  notifyWorkspace(workspaceId)
}

function archiveWorkspaceRevision(workspaceId, page) {
  const dir = store.workspaceHistoryDir(workspaceId, page.id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${revisionId()}.md`), frontmatter(page))
  const files = listMarkdownFiles(dir).sort()
  while (files.length > MAX_REVISIONS) fs.rmSync(files.shift(), { force: true })
}

export function listWorkspaceRevisions(workspaceId, pageId) {
  const dir = store.workspaceHistoryDir(workspaceId, pageId)
  return listMarkdownFiles(dir).map((filePath) => {
    const page = parsePage(fs.readFileSync(filePath, 'utf8'))
    return { id: path.basename(filePath, '.md'), savedAt: page.updatedAt, title: page.title }
  }).sort((left, right) => right.savedAt.localeCompare(left.savedAt))
}

export function readWorkspaceRevision(workspaceId, pageId, revisionIdValue, sourceId) {
  const filePath = path.join(store.workspaceHistoryDir(workspaceId, pageId), `${revisionIdValue}.md`)
  if (!fs.existsSync(filePath)) throw new Error('历史版本不存在')
  const page = parsePage(fs.readFileSync(filePath, 'utf8'))
  return withSource(page, workspaceId, sourceId)
}

export function ensureWorkspaceSolution(workspaceId, name) {
  syncRootTieFiles(store.workspaceDir(workspaceId), sourceIdFor(workspaceId), [], name)
}
