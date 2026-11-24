import { invoke } from '@tauri-apps/api/core'

export interface AuditEvent {
  at: string
  type: string
  actor?: string
  pageId?: string
  title?: string
  status?: string
  note?: string
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
