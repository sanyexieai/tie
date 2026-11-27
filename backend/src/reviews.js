import fs from 'node:fs'
import path from 'node:path'
import { notifyWorkspace } from './live.js'
import { store } from './store.js'
import crypto from 'node:crypto'
import { getWorkspacePage } from './workspace-pages.js'
import { isEncryptedMarkdown } from './page-format.js'

const STATUS_RANK = { open: 0, dropped: 1, kept: 1, final: 2 }
const OPINION_STATUS_RANK = { open: 0, resolved: 1, adopted: 2, withdrawn: 3 }
const CONTENT_FIELDS = ['quote', 'body', 'markdown', 'resolutionNote']
const MAX_ENCRYPTED_REVIEW_BYTES = 128 * 1024

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
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!parsed || !Array.isArray(parsed.entries)) throw new Error('变更记录格式无效，请先恢复记录文件')
  return { entries: parsed.entries.filter(usable) }
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
    const opinionRank = OPINION_STATUS_RANK[entry.status] ?? 0
    const previousOpinionRank = OPINION_STATUS_RANK[prev.status] ?? 0
    const laterOpinion = opinionRank > previousOpinionRank || (opinionRank === previousOpinionRank
      && String(entry.updatedAt || entry.at || '') > String(prev.updatedAt || prev.at || ''))
    const chosen = (entry.kind === 'opinion' ? laterOpinion : nextRank > prevRank) ? { ...entry } : { ...prev }
    if ((chosen.actor === '另一端' || !chosen.actor) && prev.actor && prev.actor !== '另一端') chosen.actor = prev.actor
    if ((chosen.actor === '另一端' || !chosen.actor) && entry.actor && entry.actor !== '另一端') chosen.actor = entry.actor
    map.set(entry.id, chosen)
  }
  return [...map.values()].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
}

export function saveMergedReviews(workspaceId, pageId, incoming) {
  const next = Array.isArray(incoming) ? incoming : []
  validateProtectedReviews(workspaceId, pageId, next)
  const file = reviewsFile(workspaceId, pageId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lock = file.replace(/\.json$/, '.lock')
  const deadline = Date.now() + 5000
  let descriptor
  while (descriptor === undefined) {
    try { descriptor = fs.openSync(lock, 'wx', 0o600) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (Date.now() >= deadline) throw new Error('变更记录忙，请稍后重试')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    const current = readReviews(workspaceId, pageId)
    const entries = mergeReviewEntries(current.entries, next)
    validateProtectedReviews(workspaceId, pageId, entries)
    fs.writeFileSync(temporary, `${JSON.stringify({ entries }, null, 2)}\n`)
    fs.renameSync(temporary, file)
    notifyWorkspace(workspaceId)
    return { entries }
  } finally {
    fs.closeSync(descriptor)
    fs.rmSync(lock, { force: true })
    fs.rmSync(temporary, { force: true })
  }
}

const CHANGE_FIELDS = ['title', 'markdown', 'icon', 'parentId', 'sortKey', 'tags', 'createdAt', 'deletedAt']

export function recordPageChange(workspaceId, before, after, origin = null, context = {}) {
  if (context.replication) return
  const page = after || before
  const changedFields = before && after
    ? CHANGE_FIELDS.filter((key) => JSON.stringify(before[key] ?? (key === 'tags' ? [] : key === 'sortKey' ? 0 : key === 'parentId' || key === 'deletedAt' ? null : '')) !== JSON.stringify(after[key] ?? (key === 'tags' ? [] : key === 'sortKey' ? 0 : key === 'parentId' || key === 'deletedAt' ? null : '')))
    : CHANGE_FIELDS
  if (before && after && !changedFields.length) return
  const type = !after ? 'purge' : !before ? 'create'
    : before.deletedAt !== after.deletedAt ? (after.deletedAt ? 'trash' : 'restore') : 'update'
  saveMergedReviews(workspaceId, page.id, [{
    id: `ch_${crypto.randomUUID().replaceAll('-', '')}`, kind: 'change', status: 'recorded',
    at: new Date().toISOString(), type, pageId: page.id, title: page.title,
    actor: origin?.actor || origin?.clientName || '来源未记录', origin, changedFields,
    pageUpdatedAt: after?.updatedAt || before?.updatedAt || '',
  }])
}

function invalid(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

function validateProtectedReviews(workspaceId, pageId, entries) {
  const content = entries.flatMap((entry) => CONTENT_FIELDS.map((field) => entry?.[field])).filter((value) => value != null && value !== '')
  if (!content.length) return
  let page
  try { page = getWorkspacePage(workspaceId, pageId) }
  catch (error) { if (error.message === '页面不存在') return; throw error }
  if (!isEncryptedMarkdown(page.markdown)) return
  if (content.some((value) => typeof value !== 'string' || !isEncryptedMarkdown(value))) {
    throw invalid('加密页面的讨论内容需要先解锁并加密后保存')
  }
  if (content.some((value) => Buffer.byteLength(value) > MAX_ENCRYPTED_REVIEW_BYTES)) throw invalid('加密讨论内容不能超过 128 KiB')
}

function contentLimit(value, plainLimit) {
  return isEncryptedMarkdown(value) ? Buffer.byteLength(value) <= MAX_ENCRYPTED_REVIEW_BYTES : value.length <= plainLimit
}

export function addPageSignal(workspaceId, pageId, input, origin) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('信息素内容无效')
  const page = getWorkspacePage(workspaceId, pageId)
  if (!['support', 'objection', 'correction'].includes(input.opinionKind)) throw invalid('信息素类型无效')
  if (typeof input.body !== 'string' || !input.body.trim() || !contentLimit(input.body, 100000)) throw invalid('信息素内容不能为空或过长')
  if (input.quote != null && (typeof input.quote !== 'string' || !contentLimit(input.quote, 20000))) throw invalid('引用内容无效')
  if (input.baseUpdatedAt != null && (typeof input.baseUpdatedAt !== 'string' || input.baseUpdatedAt.length > 100)) throw invalid('引用版本无效')
  if (input.actor != null && (typeof input.actor !== 'string' || input.actor.length > 240 || /[\r\n\0]/.test(input.actor))) throw invalid('意见来源无效')
  if (input.actor?.trim()) origin = { ...origin, actor: input.actor.trim() }
  const current = readReviews(workspaceId, pageId)
  if (input.replyTo && !current.entries.some((item) => item.id === input.replyTo && item.kind === 'opinion')) throw invalid('回复的信息素不存在')
  const id = input.id || `op_${crypto.randomUUID().replaceAll('-', '')}`
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw invalid('信息素 id 无效')
  if (current.entries.some((item) => item.id === id)) { validateProtectedReviews(workspaceId, pageId, [input]); return current }
  const at = new Date().toISOString()
  return saveMergedReviews(workspaceId, pageId, [{
    id, kind: 'opinion', pageId, status: 'open', at, updatedAt: at,
    opinionKind: input.opinionKind, quote: input.quote || '', body: isEncryptedMarkdown(input.body) ? input.body : input.body.trim(),
    baseUpdatedAt: input.baseUpdatedAt || page.updatedAt, replyTo: input.replyTo || null,
    actor: origin?.actor || origin?.clientName || '来源未记录', origin,
  }])
}

export function resolvePageSignal(workspaceId, pageId, id, input, origin) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('处理状态无效')
  if (!['resolved', 'adopted', 'withdrawn'].includes(input.status)) throw invalid('处理状态无效')
  if (input.resolutionNote != null && (typeof input.resolutionNote !== 'string' || !contentLimit(input.resolutionNote, 20000))) throw invalid('处理说明无效')
  const current = readReviews(workspaceId, pageId)
  const signal = current.entries.find((item) => item.kind === 'opinion' && item.id === id)
  if (!signal) throw invalid('信息素不存在')
  if ((OPINION_STATUS_RANK[input.status] ?? 0) < (OPINION_STATUS_RANK[signal.status] ?? 0)) throw invalid('已处理的信息素不能恢复到之前的状态，请创建新意见')
  if (input.status === 'adopted') {
    const page = getWorkspacePage(workspaceId, pageId)
    if (!signal.baseUpdatedAt || page.updatedAt === signal.baseUpdatedAt || input.appliedUpdatedAt !== page.updatedAt) {
      throw invalid('采用前请先保存修改，并关联当前已保存版本')
    }
  }
  return saveMergedReviews(workspaceId, pageId, [{ ...signal, status: input.status,
    updatedAt: new Date().toISOString(), resolutionOrigin: origin,
    resolutionNote: input.resolutionNote || '', appliedUpdatedAt: input.status === 'adopted' ? input.appliedUpdatedAt : null,
  }])
}
