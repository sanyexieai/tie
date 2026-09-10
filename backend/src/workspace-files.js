import fs from 'node:fs'
import path from 'node:path'
import { store } from './store.js'
import { indexEntryFromMeta, normalizeFileMeta, resourceFromMeta } from '../../shared/file-meta.js'

const MAX_REMOTE_COPY_BYTES = 20 * 1024 * 1024

export { indexEntryFromMeta, normalizeFileMeta, resourceFromMeta }

export function sanitizeFileId(fileId) {
  const id = String(fileId || '').trim()
  if (!/^file_[0-9a-f]{8,32}$/i.test(id)) {
    const error = new Error('fileId 无效')
    error.status = 400
    throw error
  }
  return id
}

export function sanitizeBlobName(name) {
  const base = path.basename(String(name || ''))
  if (!base || base === '.' || base === '..' || !/^[a-zA-Z0-9._-]+$/.test(base)) {
    const error = new Error('副本文件名无效')
    error.status = 400
    throw error
  }
  return base
}

function filesRoot(workspaceId) {
  return path.join(store.workspaceDir(workspaceId), '.tie', 'files')
}

function indexPath(workspaceId) {
  return path.join(filesRoot(workspaceId), 'index.json')
}

function metaPath(workspaceId, fileId) {
  return path.join(filesRoot(workspaceId), fileId, 'meta.json')
}

function readIndex(workspaceId) {
  const file = indexPath(workspaceId)
  if (!fs.existsSync(file)) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeIndex(workspaceId, entries) {
  const root = filesRoot(workspaceId)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(indexPath(workspaceId), `${JSON.stringify(entries, null, 2)}\n`)
}

function readMeta(workspaceId, fileId) {
  const file = metaPath(workspaceId, fileId)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function blobExists(workspaceId, fileId) {
  const dir = path.join(filesRoot(workspaceId), fileId)
  if (!fs.existsSync(dir)) return false
  return fs.readdirSync(dir).some((name) => name !== 'meta.json' && fs.statSync(path.join(dir, name)).isFile())
}

export function listWorkspaceFiles(workspaceId) {
  return readIndex(workspaceId)
    .map((entry) => readMeta(workspaceId, entry.id))
    .filter(Boolean)
    .map((meta) => resourceFromMeta(meta, {
      exists: meta.mode === 'copy' ? blobExists(workspaceId, meta.id) : false,
    }))
    .filter(Boolean)
}

export function getWorkspaceFile(workspaceId, fileId) {
  const id = sanitizeFileId(fileId)
  const meta = readMeta(workspaceId, id)
  if (!meta) {
    const error = new Error('文件资源不存在')
    error.status = 404
    throw error
  }
  return resourceFromMeta(meta, {
    exists: meta.mode === 'copy' ? blobExists(workspaceId, id) : false,
  })
}

export function upsertWorkspaceFileMeta(workspaceId, raw) {
  const id = sanitizeFileId(raw.id)
  const now = new Date().toISOString()
  const meta = normalizeFileMeta({ ...raw, id }, { now })
  const dir = path.join(filesRoot(workspaceId), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(metaPath(workspaceId, id), `${JSON.stringify(meta, null, 2)}\n`)
  const entries = readIndex(workspaceId).filter((item) => item.id !== id)
  entries.unshift(indexEntryFromMeta(meta))
  writeIndex(workspaceId, entries)
  return resourceFromMeta(meta, {
    exists: meta.mode === 'copy' ? blobExists(workspaceId, id) : false,
  })
}

export function saveWorkspaceFileBlob(workspaceId, fileId, blobName, data) {
  const id = sanitizeFileId(fileId)
  const name = sanitizeBlobName(blobName)
  if (!data?.length) {
    const error = new Error('导入内容为空')
    error.status = 400
    throw error
  }
  if (data.length > MAX_REMOTE_COPY_BYTES) {
    const error = new Error('远程导入不能超过 20 MB，请改用登记或缩小文件')
    error.status = 413
    throw error
  }
  const dir = path.join(filesRoot(workspaceId), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), data)
  return name
}

export function readWorkspaceFileBlob(workspaceId, fileId) {
  const id = sanitizeFileId(fileId)
  const dir = path.join(filesRoot(workspaceId), id)
  if (!fs.existsSync(dir)) {
    const error = new Error('副本缺失')
    error.status = 404
    throw error
  }
  const name = fs.readdirSync(dir).find((item) => item !== 'meta.json' && fs.statSync(path.join(dir, item)).isFile())
  if (!name) {
    const error = new Error('副本缺失')
    error.status = 404
    throw error
  }
  return { name, data: fs.readFileSync(path.join(dir, name)) }
}
