#!/usr/bin/env node
/**
 * 一键把本地 tie-mcp 接入 Codex / Cursor / Claude Code。
 *
 * 用法:
 *   npm run mcp:setup -- --workspace /path/to/workspace
 *   npm run mcp:setup -- -w /path/to/workspace --clients codex,cursor,claude
 *   npm run mcp:setup -- -w /path/to/workspace --dry-run
 *   TIE_WORKSPACE=/path/to/workspace npm run mcp:setup
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mcpServer = path.join(root, 'packages', 'tie-mcp', 'src', 'server.js')
const skillSrc = path.join(root, 'packages', 'tie-mcp', 'SKILL.md')
const ALL_CLIENTS = ['codex', 'cursor', 'claude']

function parseArgs(argv) {
  const out = {
    workspace: process.env.TIE_WORKSPACE || '',
    name: 'tie',
    dryRun: false,
    skipSkill: false,
    clients: [...ALL_CLIENTS],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--workspace' || arg === '-w') out.workspace = argv[++i] || ''
    else if (arg.startsWith('--workspace=')) out.workspace = arg.slice('--workspace='.length)
    else if (arg === '--name') out.name = argv[++i] || out.name
    else if (arg.startsWith('--name=')) out.name = arg.slice('--name='.length)
    else if (arg === '--clients') out.clients = parseClients(argv[++i] || '')
    else if (arg.startsWith('--clients=')) out.clients = parseClients(arg.slice('--clients='.length))
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--skip-skill') out.skipSkill = true
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return out
}

function parseClients(raw) {
  const selected = String(raw)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => (item === 'claude-code' || item === 'claudecode' ? 'claude' : item))
  const invalid = selected.filter((item) => !ALL_CLIENTS.includes(item))
  if (invalid.length) {
    throw new Error(`未知客户端：${invalid.join(', ')}（可选：${ALL_CLIENTS.join(', ')}）`)
  }
  const unique = ALL_CLIENTS.filter((item) => selected.includes(item))
  if (!unique.length) throw new Error(`请至少选择一个客户端（${ALL_CLIENTS.join(', ')}）`)
  return unique
}

function printHelp() {
  console.log(`Usage: node scripts/setup-codex-mcp.mjs [options]

Options:
  -w, --workspace <path>     Tie 工作区根目录（含 pages/）；也可设 TIE_WORKSPACE
      --clients <list>       逗号分隔：codex,cursor,claude（默认全部）
      --name <id>            MCP server 名，默认 tie
      --dry-run              只预览，不改文件
      --skip-skill           不写入/同步工作区 Skill
  -h, --help
`)
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opts,
  })
}

function which(bin) {
  const result = run(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'pipe' })
  if (result.status !== 0) return null
  return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null
}

function escapeTomlString(value) {
  return JSON.stringify(String(value))
}

function validateWorkspace(workspace) {
  const resolved = path.resolve(workspace)
  const pages = path.join(resolved, 'pages')
  if (!fs.existsSync(pages) || !fs.statSync(pages).isDirectory()) {
    throw new Error(`工作区无效：未找到 ${pages}\n请传入 --workspace /path/to/workspace（需含 pages/）`)
  }
  return resolved
}

function buildMcpBlock({ name, serverPath, workspace }) {
  return [
    `[mcp_servers.${name}]`,
    'command = "node"',
    `args = [${escapeTomlString(serverPath)}]`,
    '',
    `[mcp_servers.${name}.env]`,
    `TIE_WORKSPACE = ${escapeTomlString(workspace)}`,
    '',
  ].join('\n')
}

function buildMcpJsonEntry({ serverPath, workspace, withType }) {
  const entry = {
    command: 'node',
    args: [serverPath],
    env: { TIE_WORKSPACE: workspace },
  }
  if (withType) entry.type = 'stdio'
  return entry
}

/** Remove [mcp_servers.name] and [mcp_servers.name.*] contiguous sections. */
function stripMcpServer(toml, name) {
  const lines = toml.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  const isOwnSection = (line) => {
    const trimmed = line.trim()
    return trimmed === `[mcp_servers.${name}]` || trimmed.startsWith(`[mcp_servers.${name}.`)
  }
  while (i < lines.length) {
    if (isOwnSection(lines[i])) {
      i += 1
      while (i < lines.length) {
        const trimmed = lines[i].trim()
        if (trimmed.startsWith('[') && trimmed.ends_with(']')) {
          if (isOwnSection(lines[i])) {
            i += 1
            continue
          }
          break
        }
        i += 1
      }
      continue
    }
    out.push(lines[i])
    i += 1
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '')
}

function upsertMcpConfig(toml, opts) {
  const cleaned = stripMcpServer(toml || '', opts.name)
  const block = buildMcpBlock(opts)
  if (!cleaned) return block
  return `${cleaned}\n\n${block}`
}

function backupFile(filePath, dryRun) {
  if (!fs.existsSync(filePath)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${filePath}.bak-tie-${stamp}`
  if (dryRun) {
    console.log(`[dry-run] 备份 ${filePath} → ${backup}`)
    return backup
  }
  fs.copyFileSync(filePath, backup)
  console.log(`已备份: ${backup}`)
  return backup
}

function writeCodexConfig({ name, serverPath, workspace, dryRun }) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
  const next = upsertMcpConfig(existing, { name, serverPath, workspace })
  console.log(`Codex 配置: ${configPath}`)
  if (dryRun) {
    console.log('\n----- Codex MCP 段 -----\n')
    console.log(buildMcpBlock({ name, serverPath, workspace }))
    return
  }
  fs.mkdirSync(codexHome, { recursive: true })
  backupFile(configPath, false)
  fs.writeFileSync(configPath, `${next.trimEnd()}\n`, 'utf8')
  console.log(`已写入: ${configPath}`)
}

function upsertJsonMcpConfig({ configPath, name, serverPath, workspace, withType, dryRun, label }) {
  console.log(`${label} 配置: ${configPath}`)
  let root = {}
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8')
    if (raw.trim()) {
      root = JSON.parse(raw)
      if (!root || typeof root !== 'object' || Array.isArray(root)) {
        throw new Error(`${configPath} 根节点必须是 JSON 对象`)
      }
    }
  }
  if (!root.mcpServers || typeof root.mcpServers !== 'object' || Array.isArray(root.mcpServers)) {
    root.mcpServers = {}
  }
  root.mcpServers[name] = buildMcpJsonEntry({ serverPath, workspace, withType })
  if (dryRun) {
    console.log(`\n----- ${label} mcpServers.${name} -----\n`)
    console.log(JSON.stringify(root.mcpServers[name], null, 2))
    return
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  backupFile(configPath, false)
  fs.writeFileSync(configPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8')
  console.log(`已写入: ${configPath}`)
}

function skillMirrorRoots(clients) {
  const home = os.homedir()
  const roots = [path.join(home, '.agents', 'skills')]
  if (clients.includes('claude')) roots.push(path.join(home, '.claude', 'skills'))
  if (clients.includes('cursor')) roots.push(path.join(home, '.cursor', 'skills'))
  return roots
}

function installSkills(workspace, clients, dryRun) {
  const wsSkillDir = path.join(workspace, '.agents', 'skills', 'tie-memory')
  const wsSkill = path.join(wsSkillDir, 'SKILL.md')
  const mirrors = skillMirrorRoots(clients)

  if (dryRun) {
    console.log(`[dry-run] 工作区 Skill → ${wsSkill}`)
    for (const root of mirrors) {
      console.log(`[dry-run] 同步 Skill → ${path.join(root, 'tie-memory')}`)
    }
    return { wsSkill, mirrors }
  }

  fs.mkdirSync(wsSkillDir, { recursive: true })
  if (!fs.existsSync(wsSkill)) {
    if (!fs.existsSync(skillSrc)) throw new Error(`缺少模板：${skillSrc}`)
    fs.copyFileSync(skillSrc, wsSkill)
  }

  const skillsRoot = path.join(workspace, '.agents', 'skills')
  if (fs.existsSync(skillsRoot)) {
    for (const name of fs.readdirSync(skillsRoot)) {
      const src = path.join(skillsRoot, name, 'SKILL.md')
      if (!fs.existsSync(src)) continue
      for (const root of mirrors) {
        const destDir = path.join(root, name)
        fs.mkdirSync(destDir, { recursive: true })
        fs.copyFileSync(src, path.join(destDir, 'SKILL.md'))
      }
    }
  }

  return { wsSkill, mirrors }
}

function tryCodexCliAdd({ name, serverPath, workspace, dryRun }) {
  const bin = which('codex')
  if (!bin) {
    console.log('未检测到 PATH 中的 codex CLI（仅写 config.toml 即可生效）。')
    return
  }
  if (dryRun) {
    console.log(`[dry-run] 可选: ${bin} mcp add ${name} ...`)
    return
  }
  const help = run(bin, ['mcp', 'add', '--help'], { stdio: 'pipe' })
  if (help.status !== 0) {
    console.log('当前 codex 无 `mcp add`，已依赖 config.toml。')
    return
  }
  run(bin, ['mcp', 'remove', name], { stdio: 'pipe' })
  const added = run(
    bin,
    ['mcp', 'add', name, '--env', `TIE_WORKSPACE=${workspace}`, '--', 'node', serverPath],
    { stdio: 'inherit' },
  )
  if (added.status === 0) console.log('已同步执行 `codex mcp add`。')
  else console.log('`codex mcp add` 未成功；config.toml 已写好，一般仍可直接用。')
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.workspace) {
    printHelp()
    console.error('错误: 必须提供 --workspace 或环境变量 TIE_WORKSPACE')
    process.exit(1)
  }
  if (!fs.existsSync(mcpServer)) {
    console.error(`找不到 MCP 入口: ${mcpServer}`)
    process.exit(1)
  }

  const workspace = validateWorkspace(opts.workspace)
  console.log(`工作区: ${workspace}`)
  console.log(`MCP:    ${mcpServer}`)
  console.log(`客户端: ${opts.clients.join(', ')}`)

  if (!opts.dryRun) {
    console.log('安装 packages/tie-mcp 依赖…')
    const install = run('npm', ['install', '--prefix', 'packages/tie-mcp'], { stdio: 'inherit' })
    if (install.status !== 0) process.exit(install.status ?? 1)
  } else {
    console.log('[dry-run] 跳过 npm install')
  }

  if (opts.clients.includes('codex')) {
    writeCodexConfig({
      name: opts.name,
      serverPath: mcpServer,
      workspace,
      dryRun: opts.dryRun,
    })
  }
  if (opts.clients.includes('cursor')) {
    upsertJsonMcpConfig({
      configPath: path.join(os.homedir(), '.cursor', 'mcp.json'),
      name: opts.name,
      serverPath: mcpServer,
      workspace,
      withType: false,
      dryRun: opts.dryRun,
      label: 'Cursor',
    })
  }
  if (opts.clients.includes('claude')) {
    upsertJsonMcpConfig({
      configPath: path.join(os.homedir(), '.claude.json'),
      name: opts.name,
      serverPath: mcpServer,
      workspace,
      withType: true,
      dryRun: opts.dryRun,
      label: 'Claude Code',
    })
  }

  if (!opts.skipSkill) {
    const skills = installSkills(workspace, opts.clients, opts.dryRun)
    console.log(`工作区 Skill: ${skills.wsSkill}`)
    for (const root of skills.mirrors) {
      console.log(`已同步 Skill 根: ${root}`)
    }
  }

  if (opts.clients.includes('codex')) {
    tryCodexCliAdd({
      name: opts.name,
      serverPath: mcpServer,
      workspace,
      dryRun: opts.dryRun,
    })
  }

  console.log('\n完成。请新开对应客户端会话，然后试：用 tie_list_recent 列出最近页面')
}

try {
  main()
} catch (error) {
  console.error(error.message || error)
  process.exit(1)
}
