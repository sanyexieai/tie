#!/usr/bin/env node
/**
 * 把 Tie 接入 Codex / Cursor / Claude Code。
 *
 * 始终写入本机 tie mcp。进程会先试后台 HTTP，不通再用本地工作区。
 * --url 只作说明，不会把配置改成只剩 HTTP。
 *
 * 用法:
 *   npm run mcp:setup -- --workspace /path/to/workspace
 *   npm run mcp:setup -- -w /path/to/workspace --url http://127.0.0.1:8787/mcp
 *   npm run mcp:setup -- -w /path/to/workspace --clients cursor,claude --dry-run
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skillSrc = path.join(root, 'packages', 'tie-mcp', 'SKILL.md')
const packagedSkillsDir = path.join(root, 'packages', 'tie-mcp', 'skills')
const ALL_CLIENTS = ['codex', 'cursor', 'claude']

function parseArgs(argv) {
  const out = {
    workspace: process.env.TIE_WORKSPACE || '',
    url: process.env.TIE_MCP_URL || '',
    name: 'tie',
    dryRun: false,
    skipSkill: false,
    clients: [...ALL_CLIENTS],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--workspace' || arg === '-w') out.workspace = argv[++i] || ''
    else if (arg.startsWith('--workspace=')) out.workspace = arg.slice('--workspace='.length)
    else if (arg === '--url') out.url = argv[++i] || ''
    else if (arg.startsWith('--url=')) out.url = arg.slice('--url='.length)
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
      --url <mcp-url>        可选。只打印后台地址，配置仍写本机 tie mcp
      --clients <list>       逗号分隔：codex,cursor,claude（默认全部）
      --name <id>            MCP server 名，默认 tie
      --dry-run              只预览，不改文件
      --skip-skill           不写入/同步工作区 Skill
  -h, --help
`)
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

function servesMcp(file) {
  const result = spawnSync(file, ['--help'], { encoding: 'utf8' })
  const text = `${result.stdout || ''}\n${result.stderr || ''}`
  return text.split(/\r?\n/).some((line) => line.trim().startsWith('mcp'))
}

function resolveBundledTieCli() {
  const names = process.platform === 'win32' ? ['tie-cli.exe'] : ['tie-cli']
  const candidates = []
  for (const name of names) {
    for (const profile of ['debug', 'release']) {
      candidates.push(path.join(root, 'src-tauri', 'target', profile, name))
    }
  }
  if (process.env.TIE_CLI) candidates.push(path.resolve(process.env.TIE_CLI))
  return candidates.find((candidate) => fs.existsSync(candidate) && servesMcp(candidate)) || null
}

function normalizeMcpUrl(raw) {
  const url = String(raw || '').trim()
  if (!url) return ''
  if (!/^https?:\/\//.test(url)) throw new Error(`MCP 地址需要以 http:// 或 https:// 开头：${url}`)
  return url
}

function buildMcpBlock({ name, command, workspace }) {
  return [
    `[mcp_servers.${name}]`,
    `command = ${escapeTomlString(command)}`,
    'args = ["mcp"]',
    'enabled = true',
    '',
    `[mcp_servers.${name}.env]`,
    `TIE_WORKSPACE = ${escapeTomlString(workspace)}`,
    '',
  ].join('\n')
}

function buildMcpJsonEntry({ command, workspace, withType }) {
  const entry = {
    command,
    args: ['mcp'],
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

function writeCodexConfig({ name, url, command, workspace, dryRun }) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
  const next = upsertMcpConfig(existing, { name, url, command, workspace })
  console.log(`Codex 配置: ${configPath}`)
  if (dryRun) {
    console.log(`\n----- Codex MCP 段 -----\n${buildMcpBlock({ name, url, command, workspace })}`)
    return
  }
  fs.mkdirSync(codexHome, { recursive: true })
  backupFile(configPath, false)
  fs.writeFileSync(configPath, `${next.trimEnd()}\n`, 'utf8')
  console.log(`已写入: ${configPath}`)
}

function upsertJsonMcpConfig({ configPath, name, url, command, workspace, withType, dryRun, label }) {
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
  root.mcpServers[name] = buildMcpJsonEntry({ url, command, workspace, withType })
  if (dryRun) {
    console.log(`\n----- ${label} mcpServers.${name} -----\n${JSON.stringify(root.mcpServers[name], null, 2)}`)
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
  const mirrors = skillMirrorRoots(clients)
  const packaged = [{ name: 'tie-memory', src: skillSrc }]
  if (fs.existsSync(packagedSkillsDir)) {
    for (const name of fs.readdirSync(packagedSkillsDir)) {
      const src = path.join(packagedSkillsDir, name, 'SKILL.md')
      if (!fs.existsSync(src)) continue
      packaged.push({ name, src })
    }
  }

  if (dryRun) {
    for (const item of packaged) {
      console.log(`[dry-run] 工作区 Skill → ${path.join(workspace, '.agents', 'skills', item.name, 'SKILL.md')}`)
      for (const rootDir of mirrors) {
        console.log(`[dry-run] 同步 Skill → ${path.join(rootDir, item.name)}`)
      }
    }
    return { packaged, mirrors }
  }

  for (const item of packaged) {
    const wsSkillDir = path.join(workspace, '.agents', 'skills', item.name)
    const wsSkill = path.join(wsSkillDir, 'SKILL.md')
    fs.mkdirSync(wsSkillDir, { recursive: true })
    fs.copyFileSync(item.src, wsSkill)
  }

  const skillsRoot = path.join(workspace, '.agents', 'skills')
  if (fs.existsSync(skillsRoot)) {
    for (const name of fs.readdirSync(skillsRoot)) {
      const src = path.join(skillsRoot, name, 'SKILL.md')
      if (!fs.existsSync(src)) continue
      for (const rootDir of mirrors) {
        const destDir = path.join(rootDir, name)
        fs.mkdirSync(destDir, { recursive: true })
        fs.copyFileSync(src, path.join(destDir, 'SKILL.md'))
      }
    }
  }

  return { packaged, mirrors }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.workspace) {
    printHelp()
    console.error('错误: 必须提供 --workspace 或环境变量 TIE_WORKSPACE')
    process.exit(1)
  }

  const workspace = validateWorkspace(opts.workspace)
  const url = normalizeMcpUrl(opts.url)
  const tieCli = resolveBundledTieCli()
  console.log(`工作区: ${workspace}`)
  console.log(`本机 MCP: ${tieCli || '未找到'} mcp`)
  if (url) console.log(`后台 HTTP ${url} 由 tie mcp 在运行时先试，配置里不写 url`)
  console.log(`客户端: ${opts.clients.join(', ')}`)
  if (!tieCli && !opts.dryRun) {
    console.error('没有 tie CLI。请先构建 tie，或设置 TIE_CLI。')
    process.exit(1)
  }

  if (opts.clients.includes('codex')) {
    writeCodexConfig({ name: opts.name, url, command: tieCli, workspace, dryRun: opts.dryRun })
  }
  if (opts.clients.includes('cursor')) {
    upsertJsonMcpConfig({
      configPath: path.join(os.homedir(), '.cursor', 'mcp.json'),
      name: opts.name,
      url,
      command: tieCli,
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
      url,
      command: tieCli,
      workspace,
      withType: true,
      dryRun: opts.dryRun,
      label: 'Claude Code',
    })
  }

  if (!opts.skipSkill) {
    const skills = installSkills(workspace, opts.clients, opts.dryRun)
    console.log(`工作区 Skill: ${path.join(workspace, '.agents', 'skills')}`)
    for (const rootDir of skills.mirrors) console.log(`已同步 Skill 根: ${rootDir}`)
  }

  console.log('\n完成。客户端会启动本机 tie mcp。后台 HTTP 通的时候先走后台，不通再用本地工作区。请新开对话后使用 tie_* 工具。')
}

try {
  main()
} catch (error) {
  console.error(error.message || error)
  process.exit(1)
}
