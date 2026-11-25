#!/usr/bin/env node
/** Import the Python export using the backend's real page and file format writers. */
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { store } from '../backend/src/store.js'
import { ensureWorkspaceSolution, saveWorkspacePage } from '../backend/src/workspace-pages.js'
import { frontmatter } from '../backend/src/page-format.js'
import { saveWorkspacePageAsset } from '../backend/src/workspace-assets.js'
import { upsertWorkspaceFileMeta } from '../backend/src/workspace-files.js'

function main() {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, output: { type: 'string' }, 'legacy-data-dir': { type: 'string' },
  } })
  if (!values.output) throw new Error('--output is required')
  const target = path.resolve(values.output)
  if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length)) {
    throw new Error('Destination must be a new or empty directory')
  }
  const payload = JSON.parse(fs.readFileSync(values.input || 0, 'utf8'))
  validateSnapshot(payload)
  const users = mergeUsers(payload.users, payload.admins)
  const owners = new Set(users.map((user) => user.id))
  if (payload.workspaces.some((workspace) => !owners.has(workspace.owner_id))) {
    throw new Error('A workspace owner is missing from the legacy accounts')
  }
  const legacyRoot = path.resolve(values['legacy-data-dir'] || payload.legacyDataDir)
  if (!fs.existsSync(legacyRoot) || !fs.statSync(legacyRoot).isDirectory()) {
    throw new Error('Legacy data directory does not exist; set --legacy-data-dir to the mounted old data')
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const existingTarget = fs.existsSync(target)
  // A Docker volume mount cannot itself be renamed or removed.
  const staging = fs.mkdtempSync(path.join(existingTarget ? target : path.dirname(target), '.tie-migration-'))
  const counts = { ...payload.counts, users: users.length, admins: users.filter((user) => user.role === 'admin').length,
    assets: 0, fileResources: 0, copyFiles: 0, linkResources: 0, copiedBytes: 0 }
  try {
    process.env.TIE_DATA_DIR = staging
    store.saveUsers(users)
    store.saveWorkspaces(payload.workspaces.map((workspace) => ({
      id: workspace.id, name: workspace.name, ownerId: workspace.owner_id, createdAt: workspace.created_at,
    })))
    store.saveProviders([])
    for (const row of payload.pages) saveWorkspacePage(row.workspace_id, pageFromRow(row))
    for (const row of payload.revisions) {
      const page = { ...JSON.parse(row.page_json), id: row.page_id, updatedAt: row.saved_at }
      const dir = store.workspaceHistoryDir(row.workspace_id, row.page_id)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${row.id}.md`), frontmatter(page))
    }
    for (const workspace of payload.workspaces) {
      ensureWorkspaceSolution(workspace.id, workspace.name)
      const old = path.join(legacyRoot, 'users', workspace.owner_id, 'workspaces', workspace.id, '.tie')
      importResources(old, workspace.id, counts)
    }
    if (existingTarget) {
      if (fs.readdirSync(target).some((name) => name !== path.basename(staging))) {
        throw new Error('Destination changed during migration')
      }
      for (const name of fs.readdirSync(staging)) fs.renameSync(path.join(staging, name), path.join(target, name))
      fs.rmdirSync(staging)
    } else fs.renameSync(staging, target)
    console.log(JSON.stringify(counts))
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true })
  }
}

function validateSnapshot(payload) {
  if (payload.schemaVersion !== 1) throw new Error('Unsupported legacy export version')
  const ids = /^[A-Za-z0-9_-]{1,80}$/
  for (const key of ['users', 'admins', 'workspaces', 'pages', 'revisions']) {
    if (!Array.isArray(payload[key])) throw new Error('Invalid legacy export tables')
    if (payload[key].some((row) => !ids.test(row.id))) throw new Error('Invalid legacy record ID')
  }
  const workspaces = new Set(payload.workspaces.map((row) => row.id))
  for (const row of [...payload.pages, ...payload.revisions]) {
    if (!workspaces.has(row.workspace_id)) throw new Error('A page workspace is missing')
    if (row.page_id && !ids.test(row.page_id)) throw new Error('Invalid revision page ID')
  }
}

function mergeUsers(rows, admins) {
  const folded = (value) => String(value || '').trim().toLowerCase()
  const users = rows.map((row) => ({
    id: row.id, email: row.email, name: row.name, passwordHash: row.password_hash,
    createdAt: row.created_at, role: 'user', disabled: false,
  }))
  if (new Set(users.map((user) => folded(user.email))).size !== users.length) {
    throw new Error('Legacy users contain duplicate email addresses')
  }
  for (const admin of admins) {
    const email = folded(admin.email)
    const names = users.filter((user) => folded(user.name) === folded(admin.username))
    const existing = users.find((user) => email && folded(user.email) === email)
      || (names.length === 1 ? names[0] : undefined)
      || users.find((user) => user.id === admin.id)
    if (existing) {
      if (admin.is_active) existing.role = 'admin'
      continue
    }
    const uniqueEmail = email || `legacy-admin-${admin.id}@local.invalid`
    if (users.some((user) => folded(user.email) === uniqueEmail)) throw new Error('Legacy admin email conflict')
    users.push({ id: admin.id, email: uniqueEmail, name: admin.username, passwordHash: admin.password_hash,
      createdAt: admin.created_at, role: 'admin', disabled: !admin.is_active })
  }
  return users
}

function pageFromRow(row) {
  return { id: row.id, title: row.title, icon: row.icon || '', parentId: row.parent_id,
    sortKey: row.sort_key, markdown: row.markdown, tags: JSON.parse(row.tags || '[]'),
    createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
    storageSourceId: `backend:${row.workspace_id}`, storageSourceIds: [`backend:${row.workspace_id}`] }
}

function importResources(old, workspaceId, counts) {
  const assets = path.join(old, 'assets')
  if (fs.existsSync(assets)) {
    for (const page of fs.readdirSync(assets, { withFileTypes: true })) {
      if (!page.isDirectory() || !/^[A-Za-z0-9_-]{1,80}$/.test(page.name)) throw new Error('Invalid legacy asset directory')
      for (const file of fs.readdirSync(path.join(assets, page.name), { withFileTypes: true })) {
        if (!file.isFile()) throw new Error('Legacy assets must be regular files')
        const bytes = fs.readFileSync(path.join(assets, page.name, file.name))
        saveWorkspacePageAsset(workspaceId, page.name, file.name, bytes)
        counts.assets += 1
        counts.copiedBytes += bytes.length
      }
    }
  }
  const files = path.join(old, 'files')
  if (!fs.existsSync(files)) return
  for (const entry of fs.readdirSync(files, { withFileTypes: true })) {
    if (entry.name === 'index.json') continue
    if (!entry.isDirectory() || !/^file_[0-9a-f]{8,32}$/i.test(entry.name)) throw new Error('Invalid legacy file directory')
    const source = path.join(files, entry.name)
    const meta = JSON.parse(fs.readFileSync(path.join(source, 'meta.json'), 'utf8'))
    if (meta.id !== entry.name) throw new Error('Legacy file metadata ID mismatch')
    upsertWorkspaceFileMeta(workspaceId, meta)
    counts.fileResources += 1
    if (meta.mode === 'copy') {
      copyPayload(source, path.join(store.workspaceDir(workspaceId), '.tie', 'files', entry.name), counts, true)
    } else counts.linkResources += 1
  }
}

function copyPayload(source, target, counts, skipMeta = false) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (skipMeta && entry.name === 'meta.json') continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true })
      copyPayload(from, to, counts)
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to)
      counts.copyFiles += 1
      counts.copiedBytes += fs.statSync(from).size
    } else throw new Error('Legacy file copies must not contain symlinks')
  }
}

try { main() }
catch (error) { console.error(`Migration failed: ${error.message}`); process.exitCode = 1 }
