import fs from 'node:fs'
import path from 'node:path'
import { filenameStem } from './page-names.js'

function solutionText({ name, sourceId, rootPage = '', root = '.' }) {
  const clean = String(name ?? '').trim().replace(/[\r\n]/g, ' ')
  let text = `# Tie solution — open with Tie / \`tie open\`
tie_version: 1
kind: solution
name: ${clean}
root: ${root || '.'}
source_id: ${sourceId}
`
  if (String(rootPage ?? '').trim()) text += `root_page: ${String(rootPage).trim()}\n`
  return text
}

function lineValue(text, key) {
  const prefix = `${key}:`
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim()
  }
  return ''
}

function listSolutions(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith('.tie')) return []
    const filePath = path.join(dir, entry.name)
    const text = fs.readFileSync(filePath, 'utf8')
    if (lineValue(text, 'kind') && lineValue(text, 'kind') !== 'solution') return []
    if (lineValue(text, 'tie_version') && lineValue(text, 'tie_version') !== '1') return []
    return [{
      filePath,
      name: lineValue(text, 'name'),
      root: lineValue(text, 'root') || '.',
      sourceId: lineValue(text, 'source_id'),
      rootPage: lineValue(text, 'root_page'),
    }]
  })
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right)
}

function allocateTie(dir, stem, keep, reserved) {
  for (let n = 0; n < 10_000; n += 1) {
    const name = n === 0 ? `${stem}.tie` : `${stem}-${n + 1}.tie`
    const candidate = path.join(dir, name)
    if (reserved.some((item) => samePath(item, candidate))) continue
    if (!fs.existsSync(candidate) || (keep && samePath(keep, candidate))) return candidate
  }
  return path.join(dir, 'workspace.tie')
}

/**
 * 每个未删除的根页面一份 `<标题>.tie`。还没有页面时，用工作区名称留一份入口。
 * 规则与本地 `sync_root_tie_files` 相同。
 */
export function syncRootTieFiles(dir, sourceId, pages, fallbackName = '') {
  fs.mkdirSync(dir, { recursive: true })
  const roots = pages
    .filter((page) => !page.deletedAt && !page.parentId)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || String(left.id).localeCompare(String(right.id)))
  const existing = listSolutions(dir)
  if (!roots.length) {
    if (existing.length) return
    const label = String(fallbackName || path.basename(dir) || 'workspace').trim() || 'workspace'
    const stem = filenameStem(label, 'workspace')
    fs.writeFileSync(allocateTie(dir, stem, null, []), solutionText({ name: label, sourceId }))
    return
  }
  const managed = existing.filter((item) => {
    const root = item.root.trim()
    const local = !root || root === '.'
    return local && (!item.sourceId || item.sourceId === sourceId)
  })
  const reserved = []
  const assigned = []
  for (const page of roots) {
    const stem = filenameStem(page.title || '无标题', '无标题')
    const current = managed.find((item) => item.rootPage === page.id)
    const filePath = allocateTie(dir, stem, current?.filePath, reserved)
    if (current && !samePath(current.filePath, filePath)) fs.renameSync(current.filePath, filePath)
    const text = solutionText({
      name: String(page.title || stem).trim(),
      sourceId,
      rootPage: page.id,
    })
    if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8') !== text) fs.writeFileSync(filePath, text)
    reserved.push(filePath)
    assigned.push(path.resolve(filePath))
  }
  for (const item of managed) {
    if (!assigned.includes(path.resolve(item.filePath))) fs.rmSync(item.filePath, { force: true })
  }
}
