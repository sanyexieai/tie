/**
 * Thin bridge: MCP / scripts call the Rust `tie` CLI for page ops.
 * Set TIE_CLI to an absolute binary path, or rely on PATH / local cargo targets.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function existsExecutable(candidate) {
  if (!candidate) return false
  try {
    if (!fs.existsSync(candidate)) return false
    if (process.platform === 'win32') return true
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function which(bin) {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(cmd, [bin], { encoding: 'utf8' })
  if (result.status !== 0) return null
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || null
}

/** Resolve Rust `tie` binary. Returns null if unavailable. */
export function resolveTieCli() {
  const fromEnv = String(process.env.TIE_CLI || '').trim()
  if (fromEnv && existsExecutable(fromEnv)) return path.resolve(fromEnv)

  const names = process.platform === 'win32' ? ['tie.exe', 'tie'] : ['tie']
  for (const name of names) {
    for (const profile of ['release', 'debug']) {
      const candidate = path.join(repoRoot, 'src-tauri', 'target', profile, name)
      if (existsExecutable(candidate)) return candidate
    }
  }

  const onPath = which(process.platform === 'win32' ? 'tie.exe' : 'tie')
  if (onPath && existsExecutable(onPath)) return onPath
  return null
}

function runTie(cliPath, workspace, args, { input } = {}) {
  const hasInput = input != null
  const result = spawnSync(cliPath, ['--workspace', workspace, ...args], {
    encoding: 'utf8',
    input: hasInput ? String(input) : undefined,
    // Never inherit MCP stdio — that would corrupt JSON-RPC and steal write bodies.
    stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TIE_WORKSPACE: workspace,
      ...(process.env.TIE_SOURCE_ID || process.env.TIE_STORAGE_SOURCE_ID
        ? {
            TIE_SOURCE_ID:
              process.env.TIE_SOURCE_ID || process.env.TIE_STORAGE_SOURCE_ID,
          }
        : {}),
    },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) {
    throw new Error(`无法启动 tie CLI（${cliPath}）：${result.error.message}`)
  }
  const stderr = String(result.stderr || '').trim()
  const stdout = String(result.stdout || '').trim()
  if (result.status !== 0) {
    throw new Error(stderr || stdout || `tie 退出码 ${result.status}`)
  }
  if (!stdout) return null
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`tie CLI 返回了非 JSON：${error.message}\n${stdout.slice(0, 400)}`)
  }
}

function summarize(page) {
  return {
    id: page.id,
    title: page.title,
    tags: page.tags ?? [],
    parentId: page.parentId ?? null,
    updatedAt: page.updatedAt,
    deletedAt: page.deletedAt ?? null,
  }
}

/**
 * Workspace facade backed by `tie` CLI (same surface MCP server uses for pages).
 * Pass JS `files` / `migrationStatus` for tools not yet in Rust.
 */
export function createCliPageBackend(workspacePath, cliPath, extras = {}) {
  const root = path.resolve(workspacePath)

  return {
    root,
    pagesDir: path.join(root, 'pages'),
    backend: 'cli',
    cliPath,
    summarize,
    listRecent({ limit = 20, tag } = {}) {
      const args = ['recent', '--limit', String(limit)]
      if (tag) args.push('--tag', tag)
      const hits = runTie(cliPath, root, args) ?? []
      return hits.map((item) => ({
        ...summarize(item.page ?? item),
        snippet: item.snippet ?? '',
      }))
    },
    search({ query = '', tag, limit = 12 } = {}) {
      const args = ['search']
      const q = String(query || '').trim()
      if (q) args.push(q)
      args.push('--limit', String(limit))
      if (tag) args.push('--tag', tag)
      const payload = runTie(cliPath, root, args) ?? { results: [] }
      return (payload.results ?? []).map((item) => ({
        page: {
          id: item.page.id,
          title: item.page.title,
          tags: item.page.tags ?? [],
          parentId: item.page.parentId ?? null,
          updatedAt: item.page.updatedAt,
          deletedAt: item.page.deletedAt ?? null,
          markdown: '',
        },
        score: item.score ?? 0,
        snippet: item.snippet ?? '',
      }))
    },
    getById(idOrTitle) {
      try {
        return runTie(cliPath, root, ['get', String(idOrTitle)])
      } catch (error) {
        if (String(error.message || '').includes('页面不存在')) return null
        throw error
      }
    },
    findByTitle(title) {
      return this.getById(title)
    },
    related(idOrTitle) {
      return runTie(cliPath, root, ['related', String(idOrTitle)])
    },
    tree(rootId) {
      const args = ['tree']
      if (rootId) args.push(String(rootId))
      return runTie(cliPath, root, args) ?? []
    },
    writePage(input = {}) {
      const args = ['write']
      if (input.title) args.push('--title', String(input.title))
      if (input.pageId) args.push('--page-id', String(input.pageId))
      if (input.parentTitle) args.push('--parent-title', String(input.parentTitle))
      if (input.parentId !== undefined) {
        args.push('--parent-id', input.parentId == null ? '' : String(input.parentId))
      }
      if (input.kind) args.push('--kind', String(input.kind))
      if (input.icon) args.push('--icon', String(input.icon))
      if (input.matchTitle) args.push('--match-title')
      if (Array.isArray(input.tags)) {
        for (const tag of input.tags) args.push('--tag', String(tag))
      }
      const body = input.markdown ?? input.body
      if (body != null) {
        return runTie(cliPath, root, args, { input: String(body) })
      }
      return runTie(cliPath, root, args)
    },
    files: {
      list({ query, ext, limit = 50 } = {}) {
        const args = ['files', 'list', '--limit', String(limit)]
        if (query) args.push('--query', query)
        if (ext) args.push('--ext', ext)
        return runTie(cliPath, root, args) ?? []
      },
      getById(fileId) {
        try {
          return runTie(cliPath, root, ['files', 'get', String(fileId)])
        } catch (error) {
          if (String(error.message || '').includes('不存在')) return null
          throw error
        }
      },
      openHint(fileId) {
        return runTie(cliPath, root, ['files', 'open-hint', String(fileId)])
      },
      ingest(args = {}) {
        const mode = args.mode === 'copy' ? 'copy' : 'link'
        const argv = ['files', 'ingest', String(args.path), '--mode', mode]
        if (args.title) argv.push('--title', String(args.title))
        return runTie(cliPath, root, argv)
      },
    },
    migrationStatus: extras.migrationStatus,
  }
}
