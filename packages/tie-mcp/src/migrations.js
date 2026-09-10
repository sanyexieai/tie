/**
 * Version-gated workspace migrations that may need Agent follow-up.
 * Entries without agentFollowUp are informational only (script/stamp only).
 * No entry for a release ⇒ Agent must not invent a cleanup pass.
 */
export const MIGRATION_CATALOG = [
  {
    id: 'href-file-protocol-v1',
    title: 'file:/// → tie://path|file',
    agentFollowUp: true,
    skill: 'tie-update',
    residual: 'file:///',
    notes: 'Stamp 批量迁移可能 skip（路径缺失/无权限/跨源）；Agent 只处理 stamp 已 applied 后的残留。',
  },
]

const FILE_HREF_RE = /file:\/\/[^\s)\]>'"]+/gi

export function readAppliedMigrations(workspaceRoot, fs, path) {
  const stampPath = path.join(workspaceRoot, '.tie', 'migrations.json')
  if (!fs.existsSync(stampPath)) return { applied: [], stampPath, exists: false }
  try {
    const parsed = JSON.parse(fs.readFileSync(stampPath, 'utf8'))
    const applied = Array.isArray(parsed?.applied) ? parsed.applied.map(String) : []
    return { applied, stampPath, exists: true }
  } catch {
    return { applied: [], stampPath, exists: true, parseError: true }
  }
}

export function scanFileProtocolResiduals(pages, { limit = 50 } = {}) {
  const remainingPages = []
  let remainingHrefs = 0
  for (const page of pages) {
    const markdown = String(page.markdown || '')
    const matches = markdown.match(FILE_HREF_RE) || []
    if (!matches.length) continue
    const hrefs = [...new Set(matches)]
    remainingHrefs += hrefs.length
    remainingPages.push({
      id: page.id,
      title: page.title,
      count: hrefs.length,
      hrefs: hrefs.slice(0, 20),
      updatedAt: page.updatedAt,
    })
    if (remainingPages.length >= limit) break
  }
  return { remainingPages, remainingHrefs, truncated: remainingPages.length >= limit }
}
