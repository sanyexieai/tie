import { reactive } from 'vue'
import { clientKindLabel, formatChangeActor, isGenericChangeActor, resolveClientLabel } from '@/services/change-origin'

export type PheromoneKind = 'objection' | 'correction' | 'support'

export interface Pheromone {
  id: string
  pageId: string
  quote: string
  kind: PheromoneKind
  /** 展示用。新记录由 client + agent 组成，不再写「我」。 */
  actor: string
  client?: string
  agent?: string
  body: string
  createdAt: string
}

export interface PheromoneDraft {
  pageId: string
  quote: string
  kind: PheromoneKind
  agent: string
  body: string
}

const STORAGE_KEY = 'tie.pheromone.v1'

export const PHEROMONE_KIND_LABEL: Record<PheromoneKind, string> = {
  objection: '异议',
  correction: '修正',
  support: '支持',
}

export const PHEROMONE_KIND_COLOR: Record<PheromoneKind, string> = {
  objection: '#c46b5a',
  correction: '#6d86b5',
  support: '#6f8970',
}

function loadMap(): Record<string, Pheromone[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, Pheromone[]>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function rememberedAgent() {
  try {
    const saved = localStorage.getItem('tie.pheromone.agent')?.trim() ?? ''
    return isGenericChangeActor(saved) ? '' : saved
  } catch {
    return ''
  }
}

export const pheromoneState = reactive({
  byPage: loadMap(),
  activeId: null as string | null,
  panelOpen: false,
  openRequest: 0,
  draft: null as PheromoneDraft | null,
  clientLabel: clientKindLabel(),
  agent: rememberedAgent(),
})

export function pheromoneActorLabel(item: Pick<Pheromone, 'actor' | 'client' | 'agent'>) {
  const client = item.client?.trim() ?? ''
  const agent = item.agent?.trim() ?? ''
  if (client || agent) return formatChangeActor(client, agent)
  if (!isGenericChangeActor(item.actor)) return item.actor
  return pheromoneState.clientLabel
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pheromoneState.byPage))
  localStorage.setItem('tie.pheromone.agent', pheromoneState.agent)
}

export async function refreshChangeOrigin() {
  const label = await resolveClientLabel()
  pheromoneState.clientLabel = label
  let changed = false
  for (const list of Object.values(pheromoneState.byPage)) {
    for (const item of list) {
      if (item.client?.trim() || !isGenericChangeActor(item.actor)) continue
      item.client = label
      item.actor = label
      item.agent = ''
      changed = true
    }
  }
  if (changed) persist()
}

export function pheromonesFor(pageId: string): Pheromone[] {
  return pheromoneState.byPage[pageId] ?? []
}

export function pheromoneRevision(pageId: string) {
  return `${pheromoneState.panelOpen}:${pheromoneState.activeId ?? ''}:${pheromonesFor(pageId).map((item) => `${item.id}:${item.kind}:${item.quote}`).join('|')}`
}

export function setPheromonePanelOpen(open: boolean) {
  pheromoneState.panelOpen = open
}

function revealChangesPanel() {
  pheromoneState.panelOpen = true
  pheromoneState.openRequest += 1
  window.dispatchEvent(new CustomEvent('tie:show-changes'))
}

export function startPheromoneDraft(pageId: string, quote: string, kind: PheromoneKind) {
  pheromoneState.draft = {
    pageId,
    quote,
    kind,
    agent: pheromoneState.agent,
    body: '',
  }
  revealChangesPanel()
}

export function cancelPheromoneDraft() {
  pheromoneState.draft = null
}

export function commitPheromoneDraft() {
  const draft = pheromoneState.draft
  if (!draft) return
  const body = draft.body.trim()
  if (!body) return
  const agent = isGenericChangeActor(draft.agent) ? '' : draft.agent.trim()
  const client = pheromoneState.clientLabel
  const item: Pheromone = {
    id: `ph_${Math.random().toString(36).slice(2, 10)}`,
    pageId: draft.pageId,
    quote: draft.quote,
    kind: draft.kind,
    actor: formatChangeActor(client, agent),
    client,
    agent,
    body,
    createdAt: new Date().toISOString(),
  }
  const list = pheromoneState.byPage[draft.pageId] ?? []
  pheromoneState.byPage[draft.pageId] = [item, ...list]
  pheromoneState.agent = agent
  pheromoneState.activeId = item.id
  pheromoneState.draft = null
  persist()
}

export function removePheromone(pageId: string, id: string) {
  const list = pheromoneState.byPage[pageId] ?? []
  pheromoneState.byPage[pageId] = list.filter((item) => item.id !== id)
  if (pheromoneState.activeId === id) pheromoneState.activeId = null
  persist()
}

export function focusPheromone(id: string) {
  pheromoneState.activeId = id
  revealChangesPanel()
}
