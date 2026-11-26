import { reactive } from 'vue'
import type { Page } from '@/types'
import { clientKindLabel, isGenericChangeActor, resolveClientLabel } from '@/services/change-origin'
import { addPageOpinion, listPageReviews, reviewOriginLabel, reviewsForPage, type OpinionKind, type OpinionStatus, type ReviewEntry, type ReviewFile } from '@/services/review-service'

export type PheromoneKind = OpinionKind
export interface Pheromone {
  id: string
  pageId: string
  quote: string
  kind: PheromoneKind
  actor: string
  body: string
  createdAt: string
  status?: OpinionStatus
  origin?: ReviewEntry['origin']
  baseUpdatedAt?: string
  replyTo?: string
  resolutionOrigin?: ReviewEntry['origin']
  resolutionNote?: string
  appliedUpdatedAt?: string
  durable?: boolean
}
export interface PheromoneDraft {
  pageId: string
  quote: string
  kind: PheromoneKind
  agent: string
  body: string
  replyTo?: string
}
const STORAGE_KEY = 'tie.pheromone.v1'
export const PHEROMONE_KIND_LABEL: Record<PheromoneKind, string> = { objection: '异议', correction: '修正', support: '支持' }
export const PHEROMONE_KIND_COLOR: Record<PheromoneKind, string> = { objection: '#c46b5a', correction: '#6d86b5', support: '#6f8970' }
export const PHEROMONE_STATUS_LABEL: Record<OpinionStatus, string> = { open: '待处理', resolved: '已处理', adopted: '已采用', withdrawn: '已撤回' }

function loadLegacy(): Record<string, Pheromone[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}
function rememberedAgent() {
  try {
    const saved = localStorage.getItem('tie.pheromone.agent')?.trim() ?? ''
    return isGenericChangeActor(saved) ? '' : saved
  } catch { return '' }
}
export const pheromoneState = reactive({
  legacyByPage: loadLegacy(),
  activeId: null as string | null,
  panelOpen: false,
  openRequest: 0,
  draft: null as PheromoneDraft | null,
  clientLabel: clientKindLabel(),
  agent: rememberedAgent(),
})
export function pheromoneActorLabel(item: Pick<Pheromone, 'actor' | 'origin'>) {
  return reviewOriginLabel(item.origin, item.actor)
}
export async function refreshChangeOrigin() {
  // Historical records keep their original unknown device attribution.
  pheromoneState.clientLabel = await resolveClientLabel()
}
export function pheromonesFor(pageId: string, sourceId: string): Pheromone[] {
  const durable = reviewsForPage(pageId, sourceId).filter((item) => item.kind === 'opinion').map((item): Pheromone => ({
    id: item.id, pageId, quote: item.quote ?? '', kind: item.opinionKind ?? 'objection', actor: item.actor,
    body: item.body ?? '', createdAt: item.at, status: item.status as OpinionStatus, origin: item.origin,
    baseUpdatedAt: item.baseUpdatedAt, replyTo: item.replyTo, resolutionOrigin: item.resolutionOrigin,
    resolutionNote: item.resolutionNote, appliedUpdatedAt: item.appliedUpdatedAt, durable: true,
  }))
  const known = new Set(durable.map((item) => item.id))
  const legacy = (pheromoneState.legacyByPage[pageId] ?? []).filter((item) => !known.has(item.id)).map((item) => ({ ...item, origin: null, status: 'open' as const, durable: false }))
  return [...durable, ...legacy].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
export function pheromoneRevision(pageId: string, sourceId: string) {
  return `${pheromoneState.panelOpen}:${pheromoneState.activeId ?? ''}:${pheromonesFor(pageId, sourceId).map((item) => `${item.id}:${item.kind}:${item.status}:${item.quote}`).join('|')}`
}
export async function loadPheromones(page: Page): Promise<ReviewFile> {
  let file = await listPageReviews(page)
  for (const item of [...(pheromoneState.legacyByPage[page.id] ?? [])]) {
    let saved = file.entries.find((entry) => entry.id === item.id)
    if (!saved) {
      file = await addPageOpinion(page, { id: item.id, actor: item.actor, opinionKind: item.kind, quote: item.quote, body: item.body,
        baseUpdatedAt: '', legacy: true, at: item.createdAt,
      })
      saved = file.entries.find((entry) => entry.id === item.id)
    }
    if (!saved || saved.kind !== 'opinion' || saved.body !== item.body.trim() || saved.quote !== item.quote) throw new Error('旧意见尚未导入，原记录仍保留在本机')
    // Only remove the individual legacy record after durable storage confirms it.
    pheromoneState.legacyByPage[page.id] = (pheromoneState.legacyByPage[page.id] ?? []).filter((entry) => entry.id !== item.id)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pheromoneState.legacyByPage)) } catch { /* The durable copy is already safe. */ }
  }
  return file
}
export function setPheromonePanelOpen(open: boolean) { pheromoneState.panelOpen = open }
function revealChangesPanel() {
  pheromoneState.panelOpen = true
  pheromoneState.openRequest += 1
  window.dispatchEvent(new CustomEvent('tie:show-changes'))
}
export function startPheromoneDraft(pageId: string, quote: string, kind: PheromoneKind, replyTo?: string) {
  pheromoneState.draft = { pageId, quote, kind, agent: pheromoneState.agent, body: '', ...(replyTo ? { replyTo } : {}) }
  revealChangesPanel()
}
export function cancelPheromoneDraft() { pheromoneState.draft = null }
export async function commitPheromoneDraft(page: Page) {
  const draft = pheromoneState.draft
  if (!draft || draft.pageId !== page.id || !draft.body.trim()) return false
  const agent = isGenericChangeActor(draft.agent) ? '' : draft.agent.trim()
  const file = await addPageOpinion(page, { opinionKind: draft.kind, quote: draft.quote, body: draft.body, actor: agent,
    baseUpdatedAt: page.updatedAt, replyTo: draft.replyTo,
  })
  pheromoneState.agent = agent
  try { localStorage.setItem('tie.pheromone.agent', agent) } catch { /* Keep the current selection in memory. */ }
  pheromoneState.activeId = [...file.entries].reverse().find((item) => item.kind === 'opinion')?.id ?? null
  if (pheromoneState.draft === draft) pheromoneState.draft = null
  return true
}
export function focusPheromone(id: string) {
  pheromoneState.activeId = id
  revealChangesPanel()
}
