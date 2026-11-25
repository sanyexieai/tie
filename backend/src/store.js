import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')

function dataRoot() {
  return process.env.TIE_DATA_DIR ?? defaultRoot
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson(name, fallback) {
  const root = dataRoot()
  ensureDir(root)
  const file = path.join(root, name)
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2))
    return structuredClone(fallback)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(name, value) {
  ensureDir(dataRoot())
  fs.writeFileSync(path.join(dataRoot(), name), JSON.stringify(value, null, 2))
}

export const store = {
  get root() {
    return dataRoot()
  },
  workspaceDir(workspaceId) {
    return path.join(this.root, 'workspaces', workspaceId)
  },
  workspacePagesDir(workspaceId) {
    return path.join(this.workspaceDir(workspaceId), 'pages')
  },
  workspaceHistoryDir(workspaceId, pageId) {
    return path.join(this.workspaceDir(workspaceId), '.tie', 'history', pageId)
  },
  loadUsers() { return readJson('users.json', []) },
  saveUsers(users) { writeJson('users.json', users) },
  loadWorkspaces() {
    const workspaces = readJson('workspaces.json', [])
    let changed = false
    const next = workspaces.map((item) => {
      if (!item?.storageProviderId) return item
      changed = true
      const copy = { ...item }
      delete copy.storageProviderId
      return copy
    })
    if (changed) writeJson('workspaces.json', next)
    return next
  },
  saveWorkspaces(workspaces) { writeJson('workspaces.json', workspaces) },
  loadProviders() { return readJson('providers.json', []) },
  saveProviders(providers) { writeJson('providers.json', providers) },
  loadSettings() { return readJson('settings.json', { mcp: { enabled: false, cliPath: '' }, ai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' } }) },
  saveSettings(settings) { writeJson('settings.json', settings) },
  loadMcpTokens() { return readJson('mcp-tokens.json', []) },
  saveMcpTokens(tokens) { writeJson('mcp-tokens.json', tokens) },
  loadSessions() { return readJson('sessions.json', []) },
  saveSessions(sessions) { writeJson('sessions.json', sessions) },
}
