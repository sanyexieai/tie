import { reactive } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { Page } from '@/types'
import { backendService, isBackendSourceId, parseBackendWorkspaceId } from '@/services/backend'
import { currentChangeOrigin, isGenericChangeActor, type ChangeOrigin } from '@/services/change-origin'
import { isTemporaryStorageSourceId } from '@/services/storage-identity'
import { isFileSourceId } from '@/services/storage/types'
import { workspaceService } from '@/services/workspace'
import { useBackendStore } from '@/stores/backend'

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

function desktop() {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

export function reviewPageKey(pageId: string, sourceId: string) {
  const account = isBackendSourceId(sourceId) ? useBackendStore().profile : null
  return JSON.stringify([account?.endpoint ?? '', account?.user?.id ?? '', sourceId, pageId])
}

export function reviewsForPage(pageId: string, sourceId: string): ReviewEntry[] {
  return reviewState.byPage[reviewPageKey(pageId, sourceId)] ?? []
}

function remember(page: Page, file: ReviewFile, changed: boolean, key: string) {
  reviewState.byPage[key] = file.entries
  if (changed) window.dispatchEvent(new CustomEvent('tie:reviews-changed', { detail: { sourceId: page.storageSourceId, pageId: page.id } }))
  return file
}

function requireWritable(page: Page) {
  if (isTemporaryStorageSourceId(page.storageSourceId)) throw new Error('临时文件不保存共享意见，请先导入正式工作区')
  if (!desktop() && !isBackendSourceId(page.storageSourceId)) throw new Error('请连接服务器后留下共享意见')
}

export async function listPageReviews(page: Page): Promise<ReviewFile> {
  const key = reviewPageKey(page.id, page.storageSourceId)
  if (isBackendSourceId(page.storageSourceId)) {
    const backend = useBackendStore()
    if (!backend.connected) throw new Error('请先登录服务器')
    return remember(page, await backendService.listPageReviews(backend.profile, parseBackendWorkspaceId(page.storageSourceId), page.id), false, key)
  }
  if (!desktop()) return remember(page, { entries: [] }, false, key)
  return remember(page, await invoke<ReviewFile>('list_page_reviews', { sourceId: page.storageSourceId, pageId: page.id }), false, key)
}

export async function mergePageReviews(page: Page, entries: ReviewEntry[]): Promise<ReviewFile> {
  requireWritable(page)
  const key = reviewPageKey(page.id, page.storageSourceId)
  if (isBackendSourceId(page.storageSourceId)) {
    const backend = useBackendStore()
    return remember(page, await backendService.savePageReviews(backend.profile, parseBackendWorkspaceId(page.storageSourceId), page.id, entries), true, key)
  }
  if (!isFileSourceId(page.storageSourceId)) throw new Error('目标存储源不支持共享变更与讨论，请选择本地工作区或服务器')
  return remember(page, await invoke<ReviewFile>('merge_page_reviews', { sourceId: page.storageSourceId, pageId: page.id, entries }), true, key)
}

export async function addPageOpinion(page: Page, input: OpinionInput): Promise<ReviewFile> {
  requireWritable(page)
  const key = reviewPageKey(page.id, page.storageSourceId)
  const body = input.body.trim()
  if (!body) throw new Error('请填写意见内容')
  const origin = input.legacy ? null : await currentChangeOrigin(input.actor)
  const actor = input.legacy ? input.actor?.trim() || '来源未记录' : origin!.actor
  const id = input.id ?? `ph_${crypto.randomUUID().replaceAll('-', '')}`
  if (!isBackendSourceId(page.storageSourceId)) {
    return remember(page, await invoke<ReviewFile>('add_page_opinion', {
      sourceId: page.storageSourceId, pageId: page.id, id, actor,
      opinionKind: input.opinionKind, quote: input.quote, body,
      baseUpdatedAt: input.baseUpdatedAt, replyTo: input.replyTo ?? null,
      origin, at: input.at ?? null,
    }), !input.legacy, key)
  }
  const at = input.at ?? new Date().toISOString()
  const entry: ReviewEntry = { id, at, updatedAt: at, actor, kind: 'opinion', status: 'open', pageId: page.id,
    opinionKind: input.opinionKind, quote: input.quote, body, baseUpdatedAt: input.baseUpdatedAt,
    ...(origin ? { origin } : {}), ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  }
  const backend = useBackendStore()
  const workspaceId = parseBackendWorkspaceId(page.storageSourceId)
  const file = input.legacy
    ? await backendService.savePageReviews(backend.profile, workspaceId, page.id, [entry])
    : await backendService.addPageSignal(backend.profile, workspaceId, page.id, {
      id, actor, opinionKind: input.opinionKind, quote: input.quote, body, baseUpdatedAt: input.baseUpdatedAt, replyTo: input.replyTo,
    })
  return remember(page, file, !input.legacy, key)
}

export async function resolvePageOpinion(page: Page, item: ReviewEntry, status: Exclude<OpinionStatus, 'open'>, resolutionNote = ''): Promise<ReviewFile> {
  requireWritable(page)
  const key = reviewPageKey(page.id, page.storageSourceId)
  let appliedUpdatedAt: string | undefined
  if (status === 'adopted') {
    const latest = await workspaceService.readLatestPage(page)
    if (!item.baseUpdatedAt || !latest || latest.updatedAt === item.baseUpdatedAt) throw new Error('请先修改并保存正文，再标记采用此意见')
    appliedUpdatedAt = latest.updatedAt
  }
  const origin = await currentChangeOrigin()
  if (!isBackendSourceId(page.storageSourceId)) {
    return remember(page, await invoke<ReviewFile>('resolve_page_opinion', {
      sourceId: page.storageSourceId, pageId: page.id, id: item.id, status,
      resolutionNote, appliedUpdatedAt: appliedUpdatedAt ?? null, origin,
    }), true, key)
  }
  const backend = useBackendStore()
  return remember(page, await backendService.resolvePageSignal(backend.profile, parseBackendWorkspaceId(page.storageSourceId), page.id, item.id,
    { status, resolutionNote, appliedUpdatedAt }), true, key)
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
export const CHANGE_TYPE_LABEL: Record<string, string> = { create: '创建页面', write: '保存修改', update: '保存修改', save: '保存修改', restore: '恢复版本', delete: '移入回收站', trash: '移入回收站', import: '导入页面', move: '移动页面', rename: '重命名' }
