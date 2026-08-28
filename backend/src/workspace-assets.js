import fs from 'node:fs'
import path from 'node:path'
import { assertAssetPayload, sanitizeAssetName } from './assets.js'
import { store } from './store.js'

function assetPath(workspaceId, pageId, assetName) {
  return path.join(store.workspaceDir(workspaceId), '.tie', 'assets', pageId, sanitizeAssetName(assetName))
}

export function saveWorkspacePageAsset(workspaceId, pageId, assetName, data) {
  assertAssetPayload(data)
  const safeName = sanitizeAssetName(assetName)
  const filePath = assetPath(workspaceId, pageId, safeName)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, data)
  return safeName
}

export function readWorkspacePageAsset(workspaceId, pageId, assetName) {
  const filePath = assetPath(workspaceId, pageId, sanitizeAssetName(assetName))
  if (!fs.existsSync(filePath)) {
    const error = new Error('附件不存在')
    error.status = 404
    throw error
  }
  return fs.readFileSync(filePath)
}

export function listWorkspacePageAssets(workspaceId, pageId) {
  const dir = path.join(store.workspaceDir(workspaceId), '.tie', 'assets', pageId)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile())
}

export function deleteWorkspacePageAssets(workspaceId, pageId) {
  const dir = path.join(store.workspaceDir(workspaceId), '.tie', 'assets', pageId)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}
