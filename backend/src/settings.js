import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { store } from './store.js'

const defaultAiBase = 'https://api.openai.com/v1'

function blankSettings() {
  return {
    mcp: { enabled: false, cliPath: '' },
    ai: { baseUrl: defaultAiBase, model: 'gpt-4o-mini', apiKey: '' },
  }
}

export function loadSettings() {
  const saved = store.loadSettings()
  const base = blankSettings()
  return {
    mcp: {
      enabled: Boolean(saved?.mcp?.enabled),
      cliPath: String(saved?.mcp?.cliPath ?? '').trim(),
    },
    ai: {
      baseUrl: String(saved?.ai?.baseUrl ?? base.ai.baseUrl).trim() || defaultAiBase,
      model: String(saved?.ai?.model ?? base.ai.model).trim() || 'gpt-4o-mini',
      apiKey: String(saved?.ai?.apiKey ?? ''),
    },
  }
}

export function saveSettings(next) {
  store.saveSettings(next)
  return loadSettings()
}

export function publicSettings(settings = loadSettings(), cli = detectCli(settings.mcp.cliPath)) {
  return {
    mcp: {
      enabled: settings.mcp.enabled,
      cliPath: settings.mcp.cliPath,
      resolvedCli: cli.path,
      cliOk: cli.ok,
      cliError: cli.error,
    },
    ai: {
      baseUrl: settings.ai.baseUrl,
      model: settings.ai.model,
      hasApiKey: Boolean(settings.ai.apiKey),
    },
  }
}

export function applySettingsPatch(body = {}) {
  const current = loadSettings()
  const mcp = body.mcp && typeof body.mcp === 'object' ? body.mcp : {}
  const ai = body.ai && typeof body.ai === 'object' ? body.ai : {}
  const next = {
    mcp: {
      enabled: mcp.enabled === undefined ? current.mcp.enabled : Boolean(mcp.enabled),
      cliPath: mcp.cliPath === undefined ? current.mcp.cliPath : String(mcp.cliPath ?? '').trim(),
    },
    ai: {
      baseUrl: ai.baseUrl === undefined ? current.ai.baseUrl : (String(ai.baseUrl ?? '').trim() || defaultAiBase),
      model: ai.model === undefined ? current.ai.model : (String(ai.model ?? '').trim() || 'gpt-4o-mini'),
      apiKey: ai.apiKey === undefined ? current.ai.apiKey : String(ai.apiKey ?? ''),
    },
  }
  return saveSettings(next)
}

function which(name) {
  const command = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = spawnSync(command, [name], { encoding: 'utf8' })
  if (result.status !== 0) return null
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null
}

export function detectCli(explicit = loadSettings().mcp.cliPath) {
  const given = String(explicit ?? '').trim()
  if (given) {
    if (fs.existsSync(given)) return { ok: true, path: given, error: null }
    return { ok: false, path: given, error: '填写的 tie-cli 不存在' }
  }
  const here = path.dirname(fileURLToPath(import.meta.url))
  const names = process.platform === 'win32' ? ['tie-cli.exe'] : ['tie-cli']
  const roots = ['debug', 'release']
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.resolve(here, '../../src-tauri/target', root, name)
      if (fs.existsSync(candidate)) return { ok: true, path: candidate, error: null }
    }
  }
  const onPath = which('tie-cli')
  if (onPath && fs.existsSync(onPath)) return { ok: true, path: onPath, error: null }
  return { ok: false, path: null, error: '未找到 tie-cli。请在服务设置里填写可执行文件路径。' }
}
