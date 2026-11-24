import fs from 'node:fs'
import path from 'node:path'

const GENERIC_ACTORS = new Set(['我', 'me', 'i', 'user', 'myself', 'mcp', 'mcp-http'])

/** 不用「我」：同一人可以来自不同客户端、不同 Agent。显式人名优先，否则用 TIE_ACTOR。 */
export function resolveAuditActor(explicit) {
  const raw = String(explicit || '').trim()
  const fromEnv = String(process.env.TIE_ACTOR || '').trim()
  const generic = !raw || GENERIC_ACTORS.has(raw.toLowerCase()) || raw === '我'
  if (!generic) return raw
  return fromEnv || 'mcp'
}

/** Append a JSONL audit event under .tie/audit/events.jsonl */
export function appendAuditEvent(workspaceRoot, event) {
  try {
    const dir = path.join(workspaceRoot, '.tie', 'audit')
    fs.mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({
      at: new Date().toISOString(),
      ...event,
    })
    fs.appendFileSync(path.join(dir, 'events.jsonl'), `${line}\n`, 'utf8')
  } catch {
    /* audit must never break writes */
  }
}

export function readAuditEvents(workspaceRoot, { limit = 50, pageId } = {}) {
  const file = path.join(workspaceRoot, '.tie', 'audit', 'events.jsonl')
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  const events = []
  for (let i = lines.length - 1; i >= 0 && events.length < limit; i -= 1) {
    try {
      const item = JSON.parse(lines[i])
      if (pageId && item.pageId !== pageId) continue
      events.push(item)
    } catch {
      /* skip */
    }
  }
  return events
}
