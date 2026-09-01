/** Tie page frontmatter helpers — mirrors backend/src/page-format.js (keep in sync). */

export function frontmatter(page) {
  const parent = page.parentId ?? ''
  const tags = (page.tags ?? []).join(', ')
  const deleted = page.deletedAt ? `deleted_at: ${page.deletedAt}\n` : ''
  const icon = String(page.icon ?? '').replace(/[\n\r]/g, '')
  const primary = page.storageSourceId ?? ''
  const ids = [...new Set([primary, ...(page.storageSourceIds ?? [])].filter(Boolean))]
  const extraSources = ids.length > 1 ? `storage_source_ids: [${ids.join(', ')}]\n` : ''
  return `---\ntie_version: 1\nid: ${page.id}\nstorage_source_id: ${primary}\n${extraSources}parent_id: ${parent}\nsort_key: ${page.sortKey ?? 0}\nicon: ${icon}\ntags: [${tags}]\ncreated_at: ${page.createdAt}\nupdated_at: ${page.updatedAt}\n${deleted}---\n\n${page.markdown ?? ''}`
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
  const start = content.indexOf('---\n')
  if (start === -1) throw new Error('缺少 Frontmatter 起始标记')
  const rest = content.slice(start + 4)
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
  const title = titleLine ? titleLine.slice(2).trim() : '无标题'
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
  return `pg_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
}

export function ensureTitleMarkdown(title, body) {
  const cleanTitle = String(title || '无标题').trim() || '无标题'
  const text = String(body ?? '').replace(/^\uFEFF/, '')
  if (/^#\s+/.test(text)) return text
  const trimmed = text.trim()
  if (!trimmed) return `# ${cleanTitle}\n\n`
  return `# ${cleanTitle}\n\n${trimmed}\n`
}
