import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { store } from './store.js'
import { listWorkspacePageFiles } from './workspace-pages.js'

const resourceId = /^[A-Za-z0-9_-]{1,80}$/

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file, { bigint: true })
    return stat.isFile() ? `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}` : null
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function filesIn(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
}

function directoriesIn(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && resourceId.test(entry.name)).map((entry) => entry.name).sort()
}

function groupVersion(dir) {
  return hash(filesIn(dir).map((name) => [name, fileStamp(path.join(dir, name))]))
}

export function workspaceAssetVersions(workspaceId, pageId, names) {
  const dir = path.join(store.workspaceDir(workspaceId), '.tie', 'assets', pageId)
  return names.map((name) => ({ name, version: hash(fileStamp(path.join(dir, name))) }))
}

/** Metadata/stat fingerprints only: a periodic check never loads document bodies. */
export function workspaceSyncManifest(workspaceId) {
  const root = store.workspaceDir(workspaceId)
  const pages = listWorkspacePageFiles(workspaceId).filter(({ meta }) => resourceId.test(meta.id)).map(({ meta, filePath, metaPath }) => ({
    id: meta.id,
    version: hash([fileStamp(metaPath), fileStamp(filePath)]),
  })).sort((left, right) => left.id.localeCompare(right.id))
  const reviewDir = path.join(root, '.tie', 'reviews')
  const reviews = filesIn(reviewDir).filter((name) => name.endsWith('.json') && resourceId.test(name.slice(0, -5))).map((name) => ({
    id: name.slice(0, -5), version: hash(fileStamp(path.join(reviewDir, name))),
  }))
  const assetDir = path.join(root, '.tie', 'assets')
  const assets = directoriesIn(assetDir).map((id) => ({ id, version: groupVersion(path.join(assetDir, id)) }))
  const filesDir = path.join(root, '.tie', 'files')
  const files = directoriesIn(filesDir).filter((id) => id.startsWith('file_') && fileStamp(path.join(filesDir, id, 'meta.json'))).map((id) => ({
    id, version: groupVersion(path.join(filesDir, id)),
  }))
  const resources = { pages, reviews, assets, files }
  return { version: 1, revision: hash(resources), ...resources }
}
