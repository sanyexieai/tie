import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileMetaToJson, normalizeFileMeta } from '../../../shared/file-meta.js'
import { pathsEqual, resolveFsPath } from './fs-path.js'

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
  dir: 'inode/directory',
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

const MAX_COPY_FILE_BYTES = 50 * 1024 * 1024
const MAX_COPY_DIR_BYTES = 50 * 1024 * 1024
const MAX_COPY_DIR_FILES = 200
const MAX_COPY_DIR_DEPTH = 8

function assertCopyLimits(absPath, isDirectory, size) {
  if (!isDirectory) {
    if (size > MAX_COPY_FILE_BYTES) {
      throw new Error('导入文件不能超过 50 MB，请改用登记（绝对链接）')
    }
    return
  }
  const walk = (current, depth) => {
    if (depth > MAX_COPY_DIR_DEPTH) {
      throw new Error(`导入目录不能超过 ${MAX_COPY_DIR_DEPTH} 层，请改用登记或缩小范围`)
    }
    let totalSize = 0
    let files = 0
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        const nested = walk(full, depth + 1)
        totalSize += nested.size
        files += nested.files
      } else if (entry.isFile()) {
        files += 1
        try { totalSize += fs.statSync(full).size } catch { /* ignore */ }
      }
      if (files > MAX_COPY_DIR_FILES) {
        throw new Error(`导入目录不能超过 ${MAX_COPY_DIR_FILES} 个文件，请改用登记或缩小范围`)
      }
      if (totalSize > MAX_COPY_DIR_BYTES) {
        throw new Error('导入目录不能超过 50 MB，请改用登记或缩小范围')
      }
    }
    return { size: totalSize, files }
  }
  walk(absPath, 1)
}

function copyDirectoryRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDirectoryRecursive(from, to)
    else if (entry.isFile()) fs.copyFileSync(from, to)
  }
}

function directoryStats(dirPath) {
  let size = 0
  let files = 0
  let dirs = 0
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        dirs += 1
        walk(full)
      } else if (entry.isFile()) {
        files += 1
        try { size += fs.statSync(full).size } catch { /* ignore */ }
      }
    }
  }
  walk(dirPath)
  return { size, files, dirs }
}

function directoryPreview(dirPath, maxEntries = 24) {
  try {
    const dir = fs.opendirSync(dirPath)
    const names = []
    let truncated = false
    try {
      let entry = dir.readSync()
      while (entry) {
        if (names.length >= maxEntries) {
          truncated = true
          break
        }
        try {
          const full = path.join(dirPath, entry.name)
          const isDir = entry.isDirectory() || (() => {
            try { return fs.statSync(full).isDirectory() } catch { return false }
          })()
          names.push(isDir ? `${entry.name}/` : entry.name)
        } catch {
          names.push(entry.name)
        }
        entry = dir.readSync()
      }
    } finally {
      dir.closeSync()
    }
    if (!names.length) return '(空目录)'
    return names.join('\n') + (truncated ? '\n…' : '')
  } catch {
    return null
  }
}

export function createFileRegistry(workspaceRoot, options = {}) {
  const filesRoot = path.join(workspaceRoot, '.tie', 'files')
  const indexPath = path.join(filesRoot, 'index.json')
  const getSourceId = typeof options.getSourceId === 'function' ? options.getSourceId : null

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
    const normalized = normalizeFileMeta(meta, {
      sourceId: typeof getSourceId === 'function' ? getSourceId() : '',
    })
    const dir = path.join(filesRoot, normalized.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(metaPath(normalized.id), `${JSON.stringify(fileMetaToJson(normalized), null, 2)}\n`, 'utf8')
  }

  function upsertIndexEntry(meta) {
    const entries = readIndex().filter((item) => item.id !== meta.id)
    entries.unshift({
      id: meta.id,
      title: meta.title,
      kind: meta.kind === 'directory' ? 'directory' : 'file',
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
      const locatorPath = meta.sourcePath || meta.locator?.desktopPath
      if (absPath && locatorPath && pathsEqual(locatorPath, absPath) && meta.mode === mode) return meta
      if (mode === 'link' && absPath && pathsEqual(meta.storedPath || locatorPath, absPath)) return meta
    }
    return null
  }

  function resourceUrl(meta) {
    const sourceId = String(
      (typeof getSourceId === 'function' ? getSourceId() : '')
      || process.env.TIE_SOURCE_ID
      || process.env.TIE_STORAGE_SOURCE_ID
      || '',
    ).trim()
    const withSource = (prefix, rest) => (
      sourceId
        ? `${prefix}${encodeURIComponent(sourceId)}/${rest}`
        : `${prefix}${rest}`
    )
    if (meta.mode === 'copy' && meta.storedPath) {
      const relative = String(meta.storedPath).replace(/\\/g, '/').replace(/^\.\/+/, '')
      const encoded = relative.split('/').filter(Boolean).map((segment) => encodeURIComponent(segment)).join('/')
      return withSource('tie://path/', encoded)
    }
    return withSource('tie://file/', meta.id)
  }

  function summarize(meta) {
    if (!meta) return null
    return {
      id: meta.id,
      title: meta.title,
      kind: meta.kind === 'directory' ? 'directory' : 'file',
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
      entryCount: meta.entryCount ?? null,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      sourceId: String(
        (typeof getSourceId === 'function' ? getSourceId() : '')
        || process.env.TIE_SOURCE_ID
        || process.env.TIE_STORAGE_SOURCE_ID
        || '',
      ).trim() || null,
      url: resourceUrl(meta),
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
    const isDirectory = meta.kind === 'directory' || (openPath ? (() => {
      try { return fs.statSync(openPath).isDirectory() } catch { return false }
    })() : false)
    return {
      ...summarize(meta),
      openPath,
      exists,
      hint: exists
        ? (isDirectory
          ? `可用系统文件管理器打开目录：${openPath}`
          : `可用系统默认应用打开：${openPath}`)
        : `路径不可用（${meta.mode === 'link' ? '找不到已登记文件' : '副本缺失'}）：${openPath || '未知'}`,
    }
  }

  function ingest({ path: rawPath, mode, title } = {}) {
    const normalizedMode = mode === 'copy' || mode === 'link' ? mode : null
    if (!normalizedMode) throw new Error('mode 必须是 copy 或 link')
    const inputPath = String(rawPath || '').trim()
    if (!inputPath) throw new Error('path 必填')

    const absPath = resolveFsPath(inputPath)
    if (!fs.existsSync(absPath)) {
      throw new Error(`路径不存在：${absPath}`)
    }
    const stat = fs.statSync(absPath)
    const isDirectory = stat.isDirectory()
    if (!isDirectory && !stat.isFile()) {
      throw new Error(`不是普通文件或目录：${absPath}`)
    }

    const kind = isDirectory ? 'directory' : 'file'
    const ext = isDirectory ? 'dir' : extensionOf(absPath)
    const mime = isDirectory ? 'inode/directory' : guessMime(ext)
    const sha256 = !isDirectory && normalizedMode === 'copy' ? sha256File(absPath) : null
    // link 不扫树：大模型库等目录会卡死；copy 才需要统计体积/数量做限额
    const dirStats = isDirectory && normalizedMode === 'copy' ? directoryStats(absPath) : null
    if (normalizedMode === 'copy') {
      assertCopyLimits(absPath, isDirectory, isDirectory ? (dirStats?.size ?? 0) : stat.size)
    }

    const existing = findExisting({ absPath, sha256, mode: normalizedMode })
    if (existing) {
      // link 已登记则直接复用，勿再扫大目录做 preview/stats（会卡死）
      if (normalizedMode === 'link') {
        return { ...summarize(existing), created: false }
      }
      const preview = existing.preview
        ?? (isDirectory ? directoryPreview(absPath) : readTextPreview(absPath, ext))
      let changed = false
      if (preview && preview !== existing.preview) {
        existing.preview = preview
        changed = true
      }
      if (!existing.kind) {
        existing.kind = kind
        changed = true
      }
      if (isDirectory && dirStats) {
        existing.size = dirStats.size
        existing.entryCount = { files: dirStats.files, dirs: dirStats.dirs }
        changed = true
      }
      if (changed) {
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
      if (isDirectory) {
        const target = path.join(dir, 'original')
        copyDirectoryRecursive(absPath, target)
        storedPath = path.relative(workspaceRoot, target).split(path.sep).join('/')
      } else {
        const storedName = sanitizeStoredName(ext)
        const target = path.join(dir, storedName)
        fs.copyFileSync(absPath, target)
        storedPath = path.relative(workspaceRoot, target).split(path.sep).join('/')
      }
    }

    const meta = {
      id,
      title: baseTitle,
      kind,
      mode: normalizedMode,
      mime,
      ext,
      size: isDirectory ? (dirStats?.size ?? 0) : stat.size,
      entryCount: isDirectory && dirStats
        ? { files: dirStats.files, dirs: dirStats.dirs }
        : null,
      mtime: stat.mtime.toISOString(),
      sourcePath: absPath,
      storedPath,
      sha256,
      preview: isDirectory ? directoryPreview(absPath) : readTextPreview(absPath, ext),
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
