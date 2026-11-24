import type { Page } from '@/types'
import { normalizePageSources } from '@/services/page-sources'

function value(lines: string[], key: string) {
  const prefix = `${key}: `
  const line = lines.find((item) => item.startsWith(prefix))
  return line ? line.slice(prefix.length) : ''
}

function parseSourceIds(raw: string) {
  return raw
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

/** 历史快照用。工作区正文和 `.tiez` 里的 `pages/*.md` 不再写这份头。 */
export function frontmatter(page: Page): string {
  const parent = page.parentId ?? ''
  const tags = (page.tags ?? []).join(', ')
  const deleted = page.deletedAt ? `deleted_at: ${page.deletedAt}\n` : ''
  const icon = String(page.icon ?? '').replace(/[\n\r]/g, '')
  return `---\ntie_version: 1\nid: ${page.id}\nparent_id: ${parent}\nsort_key: ${page.sortKey ?? 0}\nicon: ${icon}\ntags: [${tags}]\ncreated_at: ${page.createdAt}\nupdated_at: ${page.updatedAt}\n${deleted}---\n\n${page.markdown ?? ''}`
}

export function parsePage(content: string): Page {
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

/** 只有 Tie 自己的头才算元数据。其他 YAML 留在正文里。 */
export function isTieDocument(content: string) {
  const normalized = String(content ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return false
  const end = normalized.indexOf('\n---\n', 4)
  if (end === -1) return false
  return normalized.slice(4, end).split('\n').some((line) => {
    const splitAt = line.indexOf(':')
    if (splitAt === -1) return false
    const key = line.slice(0, splitAt).trim()
    const field = line.slice(splitAt + 1).trim()
    if (key === 'tie_version') return field.length > 0
    if (key === 'id') return field.startsWith('pg_')
    return false
  })
}

export function pageMetaText(page: Page, relativeFile: string) {
  const parent = page.parentId ?? ''
  const tags = (page.tags ?? []).join(', ')
  const icon = String(page.icon ?? '').replace(/[\n\r]/g, '')
  const title = String(page.title ?? '').replace(/[\n\r]/g, '')
  return `tie_version: 1\nid: ${page.id}\nfile: ${relativeFile}\nparent_id: ${parent}\nsort_key: ${page.sortKey ?? 0}\nicon: ${icon}\ntitle: ${title}\ntags: [${tags}]\ncreated_at: ${page.createdAt}\nupdated_at: ${page.updatedAt}\ndeleted_at: ${page.deletedAt ?? ''}\n`
}

export function pageFromMeta(text: string, markdown: string): Page | null {
  const lines = String(text ?? '').split(/\r?\n/)
  const id = value(lines, 'id')
  const file = value(lines, 'file')
  if (!id.startsWith('pg_') || !file) return null
  const tags = value(lines, 'tags')
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
  const heading = markdown.split(/\r?\n/).find((line) => line.startsWith('# '))?.slice(2).trim()
  const storedTitle = value(lines, 'title').trim()
  const parentRaw = value(lines, 'parent_id')
  const deleted = value(lines, 'deleted_at')
  return normalizePageSources({
    id,
    title: heading || storedTitle || '无标题',
    icon: value(lines, 'icon'),
    parentId: parentRaw || null,
    sortKey: Number(value(lines, 'sort_key') || 0),
    markdown,
    tags,
    createdAt: value(lines, 'created_at') || new Date().toISOString(),
    updatedAt: value(lines, 'updated_at') || new Date().toISOString(),
    deletedAt: deleted || null,
    storageSourceId: '',
    storageSourceIds: [],
  })
}
