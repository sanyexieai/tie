/** Tie page frontmatter helpers — mirrors backend/src/page-format.js (keep in sync). */

export function frontmatter(page) {
  const parent = page.parentId ?? ''
  const tags = (page.tags ?? []).join(', ')
  const deleted = page.deletedAt ? `deleted_at: ${page.deletedAt}\n` : ''
  const icon = String(page.icon ?? '').replace(/[\n\r]/g, '')
  // 绑定源不进正文；读旧文件仍解析 storage_source_*。
  return `---\ntie_version: 1\nid: ${page.id}\nparent_id: ${parent}\nsort_key: ${page.sortKey ?? 0}\nicon: ${icon}\ntags: [${tags}]\ncreated_at: ${page.createdAt}\nupdated_at: ${page.updatedAt}\n${deleted}---\n\n${page.markdown ?? ''}`
}

function value(lines, key) {
  const prefix = `${key}: `
  const line = lines.find((item) => item.startsWith(prefix))
  return line ? line.slice(prefix.length) : ''
}

function parseSourceIds(raw) {
  return raw
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

function normalizePageSources(page) {
  const ids = [...new Set([page.storageSourceId, ...(page.storageSourceIds ?? [])].filter(Boolean))]
  const primary = ids.includes(page.storageSourceId) && page.storageSourceId
    ? page.storageSourceId
    : (ids[0] ?? page.storageSourceId ?? '')
  return {
    ...page,
    storageSourceId: primary,
    storageSourceIds: primary ? (ids.length ? ids : [primary]) : ids,
  }
}

export function parsePage(content) {
  // Accept CRLF checkouts / editors on Windows; writers still emit LF.
  const normalized = String(content ?? '').replace(/\r\n/g, '\n')
  const start = normalized.indexOf('---\n')
  if (start === -1) throw new Error('缺少 Frontmatter 起始标记')
  const rest = normalized.slice(start + 4)
  const end = rest.indexOf('---\n')
  if (end === -1) throw new Error('缺少 Frontmatter 结束标记')
  const meta = rest.slice(0, end)
  const markdown = rest.slice(end + 4).replace(/^\n/, '')
  const lines = meta.split('\n')
  const id = value(lines, 'id')
  if (!id) throw new Error('页面缺少 id')
  const tags = value(lines, 'tags')
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
  const titleLine = markdown.split('\n').find((line) => line.startsWith('# '))
  const title = titleLine ? titleLine.slice(2) : '无标题'
  const parentRaw = value(lines, 'parent_id')
  return normalizePageSources({
    id,
    title,
    icon: value(lines, 'icon'),
    parentId: parentRaw || null,
    sortKey: Number(value(lines, 'sort_key') || 0),
    markdown,
    tags,
    createdAt: value(lines, 'created_at') || new Date().toISOString(),
    updatedAt: value(lines, 'updated_at') || new Date().toISOString(),
    deletedAt: value(lines, 'deleted_at') || null,
    storageSourceId: value(lines, 'storage_source_id'),
    storageSourceIds: parseSourceIds(value(lines, 'storage_source_ids')),
  })
}

export function newPageId() {
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `pg_${hex}`
}

export function ensureTitleMarkdown(title, body) {
  const text = String(body ?? '')
  if (text.split('\n').some((line) => line.startsWith('# '))) return text
  const heading = String(title ?? '').trim() || '无标题'
  return `# ${heading}\n\n${text}`
}
