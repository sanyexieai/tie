import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yml', 'yaml',
  'toml', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'rs', 'py', 'go',
])

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  zip: 'application/zip',
}

function nowIso() {
  return new Date().toISOString()
}

function newFileId() {
  return `file_${crypto.randomBytes(8).toString('hex')}`
}

function extensionOf(filePath) {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase()
  return ext || ''
}

function guessMime(ext) {
  return MIME_BY_EXT[ext] || (TEXT_EXTS.has(ext) ? 'text/plain' : 'application/octet-stream')
}

function sanitizeStoredName(ext) {
  const clean = String(ext || '').replace(/[^a-z0-9]/gi, '').toLowerCase()
  return clean ? `original.${clean}` : 'original.bin'
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function readTextPreview(filePath, ext, maxChars = 1200) {
  if (!TEXT_EXTS.has(ext)) return null
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const trimmed = raw.replace(/\u0000/g, '').slice(0, maxChars)
    return trimmed || null
  } catch {
    return null
  }
}

export function createFileRegistry(workspaceRoot) {
  const filesRoot = path.join(workspaceRoot, '.tie', 'files')
  const indexPath = path.join(filesRoot, 'index.json')

  function ensureRoot() {
    fs.mkdirSync(filesRoot, { recursive: true })
  }

  function readIndex() {
    ensureRoot()
    if (!fs.existsSync(indexPath)) return []
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  function writeIndex(entries) {
    ensureRoot()
    fs.writeFileSync(indexPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  }

  function metaPath(fileId) {
    return path.join(filesRoot, fileId, 'meta.json')
  }

  function readMeta(fileId) {
    const file = metaPath(fileId)
    if (!fs.existsSync(file)) return null
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  function writeMeta(meta) {
    const dir = path.join(filesRoot, meta.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(metaPath(meta.id), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  }

  function upsertIndexEntry(meta) {
    const entries = readIndex().filter((item) => item.id !== meta.id)
    entries.unshift({
      id: meta.id,
      title: meta.title,
      mode: meta.mode,
      ext: meta.ext,
      mime: meta.mime,
      size: meta.size,
      updatedAt: meta.updatedAt,
    })
    writeIndex(entries)
  }

  function resolveOpenPath(meta) {
    if (!meta) return null
    if (meta.mode === 'copy') {
      return path.resolve(workspaceRoot, meta.storedPath)
    }
    return meta.storedPath
  }

  function findExisting({ absPath, sha256, mode }) {
    for (const entry of readIndex()) {
      const meta = readMeta(entry.id)
      if (!meta) continue
      if (mode && meta.mode !== mode) continue
      if (sha256 && meta.sha256 && meta.sha256 === sha256) return meta
      if (absPath && path.resolve(meta.sourcePath) === absPath && meta.mode === mode) return meta
      if (mode === 'link' && absPath && path.resolve(meta.storedPath) === absPath) return meta
    }
    return null
  }

  function summarize(meta) {
    if (!meta) return null
    return {
      id: meta.id,
      title: meta.title,
      mode: meta.mode,
      mime: meta.mime,
      ext: meta.ext,
      size: meta.size,
      mtime: meta.mtime,
      sourcePath: meta.sourcePath,
      storedPath: meta.storedPath,
      openPath: resolveOpenPath(meta),
      sha256: meta.sha256 ?? null,
      preview: meta.preview ?? null,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      url: `tie://file/${meta.id}`,
    }
  }

  function getById(fileId) {
    const id = String(fileId || '').trim()
    if (!id) return null
    return summarize(readMeta(id))
  }

  function list({ query, ext, limit = 50 } = {}) {
    const q = String(query || '').trim().toLowerCase()
    const extFilter = String(ext || '').trim().toLowerCase().replace(/^\./, '')
    let items = readIndex()
      .map((entry) => readMeta(entry.id))
      .filter(Boolean)
    if (extFilter) {
      items = items.filter((item) => item.ext === extFilter)
    }
    if (q) {
      items = items.filter((item) => {
        const hay = `${item.title} ${item.sourcePath} ${item.ext} ${item.mime}`.toLowerCase()
        return hay.includes(q)
      })
    }
    return items
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
      .map(summarize)
  }

  function openHint(fileId) {
    const meta = readMeta(String(fileId || '').trim())
    if (!meta) throw new Error(`文件资源不存在：${fileId}`)
    const openPath = resolveOpenPath(meta)
    const exists = openPath ? fs.existsSync(openPath) : false
    return {
      ...summarize(meta),
      openPath,
      exists,
      hint: exists
        ? `可用系统默认应用打开：${openPath}`
        : `路径不可用（${meta.mode === 'link' ? '外链失效' : '副本缺失'}）：${openPath || '未知'}`,
    }
  }

  function ingest({ path: rawPath, mode, title } = {}) {
    const normalizedMode = mode === 'copy' || mode === 'link' ? mode : null
    if (!normalizedMode) throw new Error('mode 必须是 copy 或 link')
    const inputPath = String(rawPath || '').trim()
    if (!inputPath) throw new Error('path 必填')

    const absPath = path.resolve(inputPath)
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      throw new Error(`文件不存在或不是普通文件：${absPath}`)
    }

    const stat = fs.statSync(absPath)
    const ext = extensionOf(absPath)
    const mime = guessMime(ext)
    const sha256 = normalizedMode === 'copy' ? sha256File(absPath) : null

    const existing = findExisting({ absPath, sha256, mode: normalizedMode })
    if (existing) {
      const preview = existing.preview ?? readTextPreview(absPath, ext)
      if (preview && preview !== existing.preview) {
        existing.preview = preview
        existing.updatedAt = nowIso()
        writeMeta(existing)
        upsertIndexEntry(existing)
      }
      return { ...summarize(existing), created: false }
    }

    const id = newFileId()
    const now = nowIso()
    const baseTitle = String(title || '').trim() || path.basename(absPath)
    let storedPath = absPath
    if (normalizedMode === 'copy') {
      const dir = path.join(filesRoot, id)
      fs.mkdirSync(dir, { recursive: true })
      const storedName = sanitizeStoredName(ext)
      const target = path.join(dir, storedName)
      fs.copyFileSync(absPath, target)
      storedPath = path.relative(workspaceRoot, target).split(path.sep).join('/')
    }

    const meta = {
      id,
      title: baseTitle,
      mode: normalizedMode,
      mime,
      ext,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      sourcePath: absPath,
      storedPath,
      sha256,
      preview: readTextPreview(absPath, ext),
      createdAt: now,
      updatedAt: now,
    }
    writeMeta(meta)
    upsertIndexEntry(meta)
    return { ...summarize(meta), created: true }
  }

  function modeById(fileId) {
    return readMeta(String(fileId || '').trim())?.mode ?? null
  }

  return {
    filesRoot,
    ingest,
    getById,
    list,
    openHint,
    modeById,
    readIndex,
  }
}
