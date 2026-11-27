import { reactive, shallowReactive, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getActivePinia } from 'pinia'
import type { Page } from '@/types'
import { backendService, isBackendSourceId, parseBackendWorkspaceId } from '@/services/backend'
import { currentBackendProfile } from '@/services/backend-profile'
import { currentChangeOrigin, isGenericChangeActor, type ChangeOrigin } from '@/services/change-origin'
import { isTemporaryStorageSourceId } from '@/services/storage-identity'
import { isFileSourceId } from '@/services/storage/types'
import { workspaceService } from '@/services/workspace'
import { useBackendStore } from '@/stores/backend'
import { useWorkspaceStore } from '@/stores/workspace'
import { isEncryptedMarkdown, encryptMarkdown } from '@/services/encrypted-markdown'
import { protectedPageAuthorization, protectedPageKey, protectedPagesRevision } from '@/services/protected-pages'
import { assertProtectedReviewEntries, protectReviewEntries, revealReviewEntries } from '@/services/protected-review-format'

export type OpinionKind = 'objection' | 'correction' | 'support'
export type OpinionStatus = 'open' | 'resolved' | 'adopted' | 'withdrawn'

export interface ReviewEntry {
  id: string
  at: string
  actor: string
  kind: string
  status: string
  pageId?: string
  title?: string
  markdown?: string
  type?: string
  changedFields?: string[]
  origin?: ChangeOrigin | null
  opinionKind?: OpinionKind
  quote?: string
  body?: string
  updatedAt?: string
  baseUpdatedAt?: string
  replyTo?: string
  resolutionOrigin?: ChangeOrigin | null
  resolutionNote?: string
  appliedUpdatedAt?: string
}

export interface ReviewFile { entries: ReviewEntry[] }

export interface OpinionInput {
  id?: string
  actor?: string
  opinionKind: OpinionKind
  quote: string
  body: string
  baseUpdatedAt: string
  replyTo?: string
  /** An old record has no trustworthy device identity or page revision. */
  legacy?: boolean
  at?: string
}

export const reviewState = reactive({ byPage: {} as Record<string, ReviewEntry[]> })
type Authorization = NonNullable<ReturnType<typeof protectedPageAuthorization>>
interface ProtectedContext { page: Page; reviewKey: string; authorization: Authorization }
interface PrivateReviewView { raw: ReviewEntry[]; context: ProtectedContext; entries: ReviewEntry[] }
const privateViews = shallowReactive(new Map<string, PrivateReviewView>())
const reviewPages = new Map<string, Page>()
const decoding = new Map<string, { raw: ReviewEntry[]; context: ProtectedContext; task: Promise<ReviewFile> }>()
const emptyEntries: ReviewEntry[] = []

watch(protectedPagesRevision, () => {
  for (const [key, cached] of privateViews) if (!current(cached.context)) privateViews.delete(key)
}, { flush: 'sync' })

function desktop() {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

export function reviewPageKey(pageId: string, sourceId: string) {
  const account = isBackendSourceId(sourceId) ? useBackendStore().profile : null
  return JSON.stringify([account?.endpoint ?? '', account?.user?.id ?? '', sourceId, pageId])
}

export function reviewsForPage(pageId: string, sourceId: string): ReviewEntry[] {
  void protectedPagesRevision.value
  const key = reviewPageKey(pageId, sourceId)
  const entries = reviewState.byPage[key] ?? emptyEntries
  const page = storedPage(pageId, sourceId, reviewPages.get(key))
  if (!page || !protectedPage(page)) return entries
  const context = authorization(page, key)
  if (!context) { privateViews.delete(key); return publicChanges(entries) }
  const cached = privateViews.get(key)
  if (cached && cached.raw === entries && sameContext(cached.context, context)) return cached.entries
  if (entries.length) void decodeReviews(entries, context).catch(() => {})
  return publicChanges(entries)
}

async function remember(page: Page, file: ReviewFile, changed: boolean, key: string, expected?: ProtectedContext | null): Promise<ReviewFile> {
  const stored = storedPage(page.id, page.storageSourceId, page)!
  const permission = protectedPageAuthorization(stored)
  if (protectedPage(stored)) assertProtectedReviewEntries(file.entries)
  reviewPages.set(key, { ...stored, markdown: permission?.ciphertext ?? stored.markdown })
  reviewState.byPage[key] = file.entries
  if (changed) window.dispatchEvent(new CustomEvent('tie:reviews-changed', { detail: { sourceId: page.storageSourceId, pageId: page.id } }))
  if (protectedPage(stored)) {
    const context = expected ?? authorization(stored, key)
    if (!context || !current(context)) return { entries: publicChanges(file.entries) }
    return decodeReviews(reviewState.byPage[key]!, context)
  }
  return file
}

function storedPage(pageId: string, sourceId: string, fallback?: Page) {
  const pinia = getActivePinia()
  return (pinia ? useWorkspaceStore(pinia).pages.find((page) => page.id === pageId && page.storageSourceId === sourceId) : undefined) ?? fallback
}
function protectedPage(page: Page) { return isEncryptedMarkdown(page.markdown) || Boolean(protectedPageKey(page)) }
function authorization(page: Page, key = reviewPageKey(page.id, page.storageSourceId)): ProtectedContext | null {
  const permission = protectedPageAuthorization(page)
  return permission ? { page, reviewKey: key, authorization: permission } : null
}
function sameContext(left: ProtectedContext, right: ProtectedContext) {
  return left.reviewKey === right.reviewKey && left.authorization.key === right.authorization.key
    && left.authorization.ciphertext === right.authorization.ciphertext && left.authorization.generation === right.authorization.generation && left.authorization.epoch === right.authorization.epoch
}
function current(context: ProtectedContext) {
  if (reviewPageKey(context.page.id, context.page.storageSourceId) !== context.reviewKey) return false
  const page = storedPage(context.page.id, context.page.storageSourceId, reviewPages.get(context.reviewKey) ?? context.page)!
  const active = authorization(page, context.reviewKey)
  return Boolean(active && sameContext(active, context))
}
function requireCurrent(context: ProtectedContext | null) {
  if (context && !current(context)) throw new Error('页面已锁定或切换账号，请重新解锁后操作')
}
function writableContext(page: Page) {
  const stored = storedPage(page.id, page.storageSourceId, page)!
  if (!protectedPage(stored)) return null
  const context = authorization(stored)
  if (!context) throw new Error('请先解锁页面再处理共享意见')
  return context
}
function publicChanges(entries: ReviewEntry[]) {
  return entries.filter((entry) => entry.kind === 'change').map((entry) => ({ ...entry, markdown: '', quote: '', body: '', resolutionNote: '' }))
}
function decodeReviews(raw: ReviewEntry[], context: ProtectedContext): Promise<ReviewFile> {
  const pending = decoding.get(context.reviewKey)
  if (pending && pending.raw === raw && sameContext(pending.context, context)) return pending.task
  const task = (async () => {
    const entries = await revealReviewEntries(raw, context.authorization.key)
    if (!current(context) || reviewState.byPage[context.reviewKey] !== raw) return { entries: publicChanges(raw) }
    privateViews.set(context.reviewKey, { raw, context, entries })
    return { entries }
  })().finally(() => { if (decoding.get(context.reviewKey)?.task === task) decoding.delete(context.reviewKey) })
  decoding.set(context.reviewKey, { raw, context, task })
  return task
}

function requireWritable(page: Page) {
  if (isTemporaryStorageSourceId(page.storageSourceId)) throw new Error('临时文件不保存共享意见，请先导入正式工作区')
  if (!desktop() && !isBackendSourceId(page.storageSourceId)) throw new Error('请连接服务器后留下共享意见')
}

export async function listPageReviews(page: Page): Promise<ReviewFile> {
  const key = reviewPageKey(page.id, page.storageSourceId)
  const context = authorization(storedPage(page.id, page.storageSourceId, page)!, key)
  if (isBackendSourceId(page.storageSourceId) && !useBackendStore().connected) throw new Error('请先登录服务器')
  return remember(page, await readPageReviewStorage(page), false, key, context)
}

/** Storage transfers copy the original payload, including opinions on locked pages. */
export async function readPageReviewStorage(page: Page): Promise<ReviewFile> {
  let file: ReviewFile
  if (isBackendSourceId(page.storageSourceId)) {
    const profile = currentBackendProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    file = await backendService.listPageReviews(profile, parseBackendWorkspaceId(page.storageSourceId), page.id)
  } else file = desktop() ? await invoke<ReviewFile>('list_page_reviews', { sourceId: page.storageSourceId, pageId: page.id }) : { entries: [] }
  if (protectedPage(page)) assertProtectedReviewEntries(file.entries)
  return file
}

export async function mergePageReviews(page: Page, entries: ReviewEntry[]): Promise<ReviewFile> {
  requireWritable(page)
  const key = reviewPageKey(page.id, page.storageSourceId)
  const context = writableContext(page)
  const stored = context ? await protectReviewEntries(entries, context.authorization.key) : entries
  requireCurrent(context)
  return remember(page, await mergePageReviewStorage(page, stored), true, key, context)
}

/** Accepts stored ciphertext, never a decrypted or redacted UI review view. */
export async function mergePageReviewStorage(page: Page, entries: ReviewEntry[]): Promise<ReviewFile> {
  requireWritable(page)
  if (protectedPage(page)) assertProtectedReviewEntries(entries)
  let file: ReviewFile
  if (isBackendSourceId(page.storageSourceId)) {
    const profile = currentBackendProfile()
    if (!profile.accessToken) throw new Error('请先连接自定义后台')
    file = await backendService.savePageReviews(profile, parseBackendWorkspaceId(page.storageSourceId), page.id, entries)
  } else {
    if (!isFileSourceId(page.storageSourceId)) throw new Error('目标存储源不支持共享变更与讨论，请选择本地工作区或服务器')
    file = await invoke<ReviewFile>('merge_page_reviews', { sourceId: page.storageSourceId, pageId: page.id, entries })
  }
  if (protectedPage(page)) assertProtectedReviewEntries(file.entries)
  return file
}

export async function addPageOpinion(page: Page, input: OpinionInput): Promise<ReviewFile> {
  requireWritable(page)
  const key = reviewPageKey(page.id, page.storageSourceId)
  const context = writableContext(page)
  if (context && input.legacy) throw new Error('加密页面不自动迁入旧明文意见')
  const body = input.body.trim()
  if (!body) throw new Error('请填写意见内容')
  const origin = input.legacy ? null : await currentChangeOrigin(input.actor)
  const actor = input.legacy ? input.actor?.trim() || '来源未记录' : origin!.actor
  const id = input.id ?? `ph_${crypto.randomUUID().replaceAll('-', '')}`
  const [payload] = context ? await protectReviewEntries([{ id, at: '', actor, kind: 'opinion', status: 'open', quote: input.quote, body }], context.authorization.key)
    : [{ quote: input.quote, body }]
  requireCurrent(context)
  if (!isBackendSourceId(page.storageSourceId)) {
    return remember(page, await invoke<ReviewFile>('add_page_opinion', {
      sourceId: page.storageSourceId, pageId: page.id, id, actor,
      opinionKind: input.opinionKind, quote: payload!.quote, body: payload!.body,
      baseUpdatedAt: input.baseUpdatedAt, replyTo: input.replyTo ?? null,
      origin, at: input.at ?? null,
    }), !input.legacy, key, context)
  }
  const at = input.at ?? new Date().toISOString()
  const entry: ReviewEntry = { id, at, updatedAt: at, actor, kind: 'opinion', status: 'open', pageId: page.id,
    opinionKind: input.opinionKind, quote: payload!.quote, body: payload!.body, baseUpdatedAt: input.baseUpdatedAt,
    ...(origin ? { origin } : {}), ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  }
  const backend = useBackendStore()
  const workspaceId = parseBackendWorkspaceId(page.storageSourceId)
  const file = input.legacy
    ? await backendService.savePageReviews(backend.profile, workspaceId, page.id, [entry])
    : await backendService.addPageSignal(backend.profile, workspaceId, page.id, {
      id, actor, opinionKind: input.opinionKind, quote: payload!.quote!, body: payload!.body!, baseUpdatedAt: input.baseUpdatedAt, replyTo: input.replyTo,
    })
  return remember(page, file, !input.legacy, key, context)
}

export async function resolvePageOpinion(page: Page, item: ReviewEntry, status: Exclude<OpinionStatus, 'open'>, resolutionNote = ''): Promise<ReviewFile> {
  requireWritable(page)
  const key = reviewPageKey(page.id, page.storageSourceId)
  const context = writableContext(page)
  let appliedUpdatedAt: string | undefined
  if (status === 'adopted') {
    const latest = await workspaceService.readLatestPage(page)
    if (!item.baseUpdatedAt || !latest || latest.updatedAt === item.baseUpdatedAt) throw new Error('请先修改并保存正文，再标记采用此意见')
    appliedUpdatedAt = latest.updatedAt
  }
  const origin = await currentChangeOrigin()
  const note = context && resolutionNote ? await encryptMarkdown(resolutionNote, context.authorization.key) : resolutionNote
  if (context && note.length > 128 * 1024) throw new Error('处理说明过长，无法加密保存')
  requireCurrent(context)
  if (!isBackendSourceId(page.storageSourceId)) {
    return remember(page, await invoke<ReviewFile>('resolve_page_opinion', {
      sourceId: page.storageSourceId, pageId: page.id, id: item.id, status,
      resolutionNote: note, appliedUpdatedAt: appliedUpdatedAt ?? null, origin,
    }), true, key, context)
  }
  const backend = useBackendStore()
  return remember(page, await backendService.resolvePageSignal(backend.profile, parseBackendWorkspaceId(page.storageSourceId), page.id, item.id,
    { status, resolutionNote: note, appliedUpdatedAt }), true, key, context)
}

export function reviewOriginLabel(origin?: ChangeOrigin | null, actor?: string) {
  if (!origin) return !isGenericChangeActor(actor) && actor !== '另一端' ? `${actor} · 设备来源未记录` : '来源未记录'
  return [...new Set([origin.actor, origin.clientName, origin.deviceName || origin.platform].filter(Boolean))].join(' · ') || '来源未记录'
}

export function reviewOriginDetails(origin?: ChangeOrigin | null) {
  if (!origin) return '历史记录未保存客户端或设备身份'
  return [origin.clientId && `客户端：${origin.clientId}`, origin.clientVersion && `版本：${origin.clientVersion}`, origin.deviceId && `设备：${origin.deviceId}`, origin.platform].filter(Boolean).join('\n')
}

export const CHANGE_FIELD_LABEL: Record<string, string> = { markdown: '正文', title: '标题', tags: '标签', icon: '图标', parentId: '父页面', parent_id: '父页面', sortKey: '顺序', sort_key: '顺序', deletedAt: '回收站状态', deleted_at: '回收站状态' }
export const CHANGE_TYPE_LABEL: Record<string, string> = { create: '创建页面', write: '保存修改', update: '保存修改', save: '保存修改', restore: '恢复版本', encrypt: '加密页面', decrypt: '转为普通页面', delete: '移入回收站', trash: '移入回收站', import: '导入页面', move: '移动页面', rename: '重命名' }
