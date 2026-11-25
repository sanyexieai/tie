/**
 * 工作区只落在服务器磁盘。HTTP MCP 和同步读写的是同一份目录。
 */
import { notifyWorkspace } from './live.js'
import { deleteWorkspacePageAssets, listWorkspacePageAssets, readWorkspacePageAsset, saveWorkspacePageAsset } from './workspace-assets.js'
import {
  deleteWorkspacePages,
  getWorkspacePage,
  listWorkspacePages,
  listWorkspaceRevisions,
  readWorkspaceRevision,
  saveWorkspacePage,
} from './workspace-pages.js'

function sourceIdFor(workspace) {
  return `backend:${workspace.id}`
}

function withWorkspaceSource(page, workspace) {
  const id = sourceIdFor(workspace)
  return { ...page, storageSourceId: id, storageSourceIds: [id] }
}

export async function listPages(workspace) {
  return listWorkspacePages(workspace.id, sourceIdFor(workspace))
}

export async function getPage(workspace, pageId) {
  return getWorkspacePage(workspace.id, pageId, sourceIdFor(workspace))
}

export async function savePage(workspace, page, expectedUpdatedAt) {
  const next = withWorkspaceSource({ ...page, updatedAt: page.updatedAt || new Date().toISOString() }, workspace)
  const saved = saveWorkspacePage(workspace.id, next, expectedUpdatedAt)
  notifyWorkspace(workspace.id)
  return saved
}

export async function removePages(workspace, pageIds) {
  deleteWorkspacePages(workspace.id, pageIds ?? [])
  notifyWorkspace(workspace.id)
}

export async function listRevisions(workspace, pageId) {
  return listWorkspaceRevisions(workspace.id, pageId)
}

export async function readRevision(workspace, pageId, revisionId) {
  return readWorkspaceRevision(workspace.id, pageId, revisionId, sourceIdFor(workspace))
}

export async function saveAsset(workspace, pageId, assetName, data) {
  const saved = saveWorkspacePageAsset(workspace.id, pageId, assetName, data)
  notifyWorkspace(workspace.id)
  return saved
}

export async function readAsset(workspace, pageId, assetName) {
  return readWorkspacePageAsset(workspace.id, pageId, assetName)
}

export async function listAssets(workspace, pageId) {
  return listWorkspacePageAssets(workspace.id, pageId)
}

export { deleteWorkspacePageAssets, sourceIdFor }
