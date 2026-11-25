import fs from 'node:fs'
import path from 'node:path'
import { notifyWorkspace } from './live.js'
import { store } from './store.js'

const STATUS_RANK = { open: 0, dropped: 1, kept: 1, final: 2 }

function assertPageId(pageId) {
  const id = String(pageId ?? '')
  if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) {
    const error = new Error('页面 id 无效')
    error.status = 400
    throw error
  }
  return id
}

export function reviewsFile(workspaceId, pageId) {
  return path.join(store.workspaceDir(workspaceId), '.tie', 'reviews', `${assertPageId(pageId)}.json`)
}

function usable(entry) {
  return Boolean(entry && typeof entry.id === 'string' && entry.id && !entry.id.includes('/') && !entry.id.includes('\\') && typeof entry.kind === 'string')
}

export function readReviews(workspaceId, pageId) {
  const file = reviewsFile(workspaceId, pageId)
  if (!fs.existsSync(file)) return { entries: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const entries = Array.isArray(parsed.entries) ? parsed.entries.filter(usable) : []
    return { entries }
  } catch {
    return { entries: [] }
  }
}

export function mergeReviewEntries(current, incoming) {
  const map = new Map()
  for (const entry of current.filter(usable)) map.set(entry.id, entry)
  for (const entry of incoming.filter(usable)) {
    const prev = map.get(entry.id)
    if (!prev) {
      map.set(entry.id, entry)
      continue
    }
    const prevRank = STATUS_RANK[prev.status] ?? 0
    const nextRank = STATUS_RANK[entry.status] ?? 0
    const chosen = nextRank > prevRank ? { ...entry } : { ...prev }
    if ((chosen.actor === '另一端' || !chosen.actor) && prev.actor && prev.actor !== '另一端') chosen.actor = prev.actor
    if ((chosen.actor === '另一端' || !chosen.actor) && entry.actor && entry.actor !== '另一端') chosen.actor = entry.actor
    map.set(entry.id, chosen)
  }
  return [...map.values()].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
}

export function saveMergedReviews(workspaceId, pageId, incoming) {
  const current = readReviews(workspaceId, pageId)
  const entries = mergeReviewEntries(current.entries, Array.isArray(incoming) ? incoming : [])
  const file = reviewsFile(workspaceId, pageId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ entries }, null, 2)}\n`)
  notifyWorkspace(workspaceId)
  return { entries }
}
