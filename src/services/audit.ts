import { invoke } from '@tauri-apps/api/core'
import type { ChangeOrigin } from '@/services/change-origin'

export interface AuditEvent {
  id?: string
  at: string
  type: string
  actor?: string
  pageId?: string
  title?: string
  status?: string
  note?: string
  origin?: ChangeOrigin | null
  changedFields?: string[]
}

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function listPageAuditEvents(sourceId: string, pageId: string, limit = 40): Promise<AuditEvent[]> {
  if (!isTauri()) return []
  try {
    return await invoke<AuditEvent[]>('list_page_audit_events', { sourceId, pageId, limit })
  } catch {
    return []
  }
}
