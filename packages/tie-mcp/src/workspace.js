import fs from 'node:fs'
import path from 'node:path'
import { ensureTitleMarkdown, frontmatter, newPageId, parsePage } from './page-format.js'

const LINK_TITLE_RE = /\[\[([^\]]+)\]\]/g
const LINK_ID_RE = /tie:\/\/page\/([A-Za-z0-9_-]+)/g

function nowIso() {
  return new Date().toISOString()
}

function resolveWorkspaceRoot(raw) {
  const root = path.resolve(raw || process.env.TIE_WORKSPACE || '')
  if (!root || root === path.resolve('')) {
    throw new Error('请设置 TIE_WORKSPACE 为 Tie 工作区根目录（含 pages/）')
  }
  const pagesDir = path.join(root, 'pages')
  if (!fs.existsSync(pagesDir) || !fs.statSync(pagesDir).isDirectory()) {
    throw new Error(`工作区无效：未找到 ${pagesDir}`)
  }
  return root
}

export function createWorkspace(workspacePath) {
  const root = resolveWorkspaceRoot(workspacePath)
  const pagesDir = path.join(root, 'pages')
  const historyRoot = path.join(root, '.tie', 'history')
  const storageSourceId = process.env.TIE_STORAGE_SOURCE_ID || ''

  function listPageFiles() {
    return fs.readdirSync(pagesDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => path.join(pagesDir, name))
  }

  function loadAll({ includeDeleted = false } = {}) {
    const pages = []
    for (const file of listPageFiles()) {
      try {
        const page = parsePage(fs.readFileSync(file, 'utf8'))
        if (!includeDeleted && page.deletedAt) continue
        pages.push(page)
      } catch {
        /* skip malformed */
      }
    }
    return pages
  }

  function getById(pageId) {
    const file = path.join(pagesDir, `${pageId}.md`)
    if (!fs.existsSync(file)) return null
    const page = parsePage(fs.readFileSync(file, 'utf8'))
    return page
  }

  function findByTitle(title) {
    const needle = String(title || '').trim().toLowerCase()
    if (!needle) return null
    return loadAll().find((page) => page.title.toLowerCase() === needle) ?? null
  }

  function scorePage(page, query) {
    const q = query.toLowerCase()
    const title = page.title.toLowerCase()
    const tags = page.tags.map((t) => t.toLowerCase())
    const body = page.markdown.toLowerCase()
    let score = 0
    if (title === q) score += 100
    else if (title.includes(q)) score += 40
    for (const tag of tags) {
      if (tag === q) score += 30
      else if (tag.includes(q)) score += 12
    }
    const tokens = q.split(/\s+/).filter((t) => t.length >= 2)
    for (const token of tokens) {
      if (title.includes(token)) score += 8
      if (tags.some((tag) => tag.includes(token))) score += 5
      const hits = body.split(token).length - 1
      if (hits > 0) score += Math.min(hits, 8)
    }
    return score
  }

  function snippet(page, query) {
    const q = query.toLowerCase()
    const lines = page.markdown.split('\n')
    const hit = lines.find((line) => line.toLowerCase().includes(q))
    if (hit) return hit.trim().slice(0, 160)
    return lines.find((line) => line.trim() && !line.startsWith('#'))?.trim().slice(0, 160) ?? ''
  }

  function search({ query, tag, limit = 12, includeDeleted = false } = {}) {
    const q = String(query || '').trim()
    const tagFilter = String(tag || '').trim().toLowerCase()
    let pages = loadAll({ includeDeleted })
    if (tagFilter) {
      pages = pages.filter((page) => page.tags.some((item) => item.toLowerCase() === tagFilter))
    }
    if (!q && !tagFilter) {
      return pages
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)
        .map((page) => ({ page, score: 0, snippet: snippet(page, '') }))
    }
    return pages
      .map((page) => ({ page, score: q ? scorePage(page, q) : 1, snippet: snippet(page, q || tagFilter) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.page.updatedAt.localeCompare(a.page.updatedAt))
      .slice(0, limit)
  }

  function extractOutgoing(page, byId, byTitle) {
    const targets = new Set()
    for (const match of page.markdown.matchAll(LINK_ID_RE)) {
      if (byId.has(match[1])) targets.add(match[1])
    }
    for (const match of page.markdown.matchAll(LINK_TITLE_RE)) {
      const found = byTitle.get(match[1].trim().toLowerCase())
      if (found) targets.add(found.id)
    }
    return [...targets]
  }

  function related(pageId) {
    const page = getById(pageId) || findByTitle(pageId)
    if (!page) throw new Error(`页面不存在：${pageId}`)
    const all = loadAll()
    const byId = new Map(all.map((item) => [item.id, item]))
    const byTitle = new Map(all.map((item) => [item.title.toLowerCase(), item]))
    const outgoing = extractOutgoing(page, byId, byTitle).map((id) => byId.get(id)).filter(Boolean)
    const incoming = all.filter((item) => item.id !== page.id && extractOutgoing(item, byId, byTitle).includes(page.id))
    const sameTags = all.filter((item) => (
      item.id !== page.id
      && item.tags.some((tag) => page.tags.includes(tag))
    )).slice(0, 20)
    const children = all.filter((item) => item.parentId === page.id)
    return {
      page: summarize(page),
      outgoing: outgoing.map(summarize),
      incoming: incoming.map(summarize),
      children: children.map(summarize),
      sameTags: sameTags.map(summarize),
    }
  }

  function summarize(page) {
    return {
      id: page.id,
      title: page.title,
      tags: page.tags,
      parentId: page.parentId,
      updatedAt: page.updatedAt,
      deletedAt: page.deletedAt,
    }
  }

  function archiveRevision(page) {
    const dir = path.join(historyRoot, page.id)
    fs.mkdirSync(dir, { recursive: true })
    const revisionId = `${Date.now()}`
    fs.writeFileSync(path.join(dir, `${revisionId}.md`), frontmatter(page), 'utf8')
  }

  function nextSortKey(parentId) {
    if (!parentId) return Date.now() % 1_000_000
    const siblings = loadAll().filter((page) => page.parentId === parentId)
    if (!siblings.length) return 1
    return Math.max(...siblings.map((page) => Number(page.sortKey) || 0)) + 1
  }

  function writePage(input = {}) {
    const title = String(input.title || '').trim()
    if (!title && !input.pageId) throw new Error('创建页面需要 title')

    const existing = input.pageId
      ? getById(input.pageId)
      : (input.matchTitle ? findByTitle(title) : null)

    if (input.pageId && !existing) throw new Error(`页面不存在：${input.pageId}`)

    const now = nowIso()
    const tags = Array.isArray(input.tags)
      ? input.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : (existing?.tags ?? [])

    let parentId = existing?.parentId ?? null
    if (input.parentId !== undefined) parentId = input.parentId || null
    if (input.parentTitle) {
      const parent = findByTitle(input.parentTitle)
      if (!parent) throw new Error(`父页面不存在：${input.parentTitle}`)
      parentId = parent.id
    }

    const kindTags = {
      decision: ['memory', 'decision'],
      bug: ['memory', 'bug'],
      preference: ['memory', 'preference'],
      note: ['memory'],
    }
    if (input.kind && kindTags[input.kind]) {
      for (const tag of kindTags[input.kind]) {
        if (!tags.some((item) => item.toLowerCase() === tag)) tags.push(tag)
      }
    }

    const markdown = ensureTitleMarkdown(
      title || existing?.title || '无标题',
      input.markdown ?? input.body ?? existing?.markdown ?? '',
    )

    const page = {
      id: existing?.id ?? newPageId(),
      title: title || existing?.title || '无标题',
      icon: input.icon ?? existing?.icon ?? '',
      parentId,
      sortKey: existing?.sortKey ?? nextSortKey(parentId),
      markdown,
      tags,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: existing?.deletedAt ?? null,
      storageSourceId: existing?.storageSourceId || storageSourceId,
    }

    // refresh title from markdown heading
    const heading = markdown.split('\n').find((line) => line.startsWith('# '))
    if (heading) page.title = heading.slice(2).trim() || page.title

    if (existing) archiveRevision(existing)

    const file = path.join(pagesDir, `${page.id}.md`)
    fs.writeFileSync(file, frontmatter(page), 'utf8')
    // parent_id 是树真相源；父页末尾子链接由 Tie 桌面端按父子 id 补全，MCP 不写
    return { page: summarize(page), path: file, created: !existing }
  }

  function listRecent({ limit = 20, tag } = {}) {
    return search({ query: '', tag, limit }).map((item) => ({
      ...summarize(item.page),
      snippet: item.snippet,
    }))
  }

  return {
    root,
    pagesDir,
    loadAll,
    getById,
    findByTitle,
    search,
    related,
    writePage,
    listRecent,
    summarize,
  }
}
