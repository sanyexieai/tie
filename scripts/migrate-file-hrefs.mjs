#!/usr/bin/env node
/**
 * Update helper for one-shot workspace href migration (`href-file-protocol-v1`).
 *
 * The rewrite runs inside Tie exactly once when the stamp is missing.
 * This script only inspects / resets / marks the stamp — it does not hardcode
 * page content or run on every app launch.
 *
 * Stamp file (default workspace):
 *   ~/.local/share/com.tie.knowledge/workspace/.tie/migrations.json
 *
 * Usage:
 *   node scripts/migrate-file-hrefs.mjs
 *   node scripts/migrate-file-hrefs.mjs --reset   # next Tie launch migrates once
 *   node scripts/migrate-file-hrefs.mjs --mark    # skip rewrite, mark done
 *   node scripts/migrate-file-hrefs.mjs --workspace /path/to/workspace
 */

import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION_ID = 'href-file-protocol-v1'

function parseArgs(argv) {
  const out = { reset: false, mark: false, workspace: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--reset') out.reset = true
    else if (arg === '--mark') out.mark = true
    else if (arg === '--workspace') out.workspace = argv[++i] ?? null
  }
  return out
}

function defaultWorkspace() {
  return join(homedir(), '.local', 'share', 'com.tie.knowledge', 'workspace')
}

function stampPath(workspace) {
  return join(workspace, '.tie', 'migrations.json')
}

function readApplied(path) {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed?.applied) ? parsed.applied.map(String) : []
  } catch {
    return []
  }
}

function writeApplied(path, applied) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ applied: [...new Set(applied)] }, null, 2)}\n`)
}

const args = parseArgs(process.argv.slice(2))
const workspace = args.workspace || defaultWorkspace()
const path = stampPath(workspace)
const applied = readApplied(path)
const has = applied.includes(MIGRATION_ID)

if (args.reset) {
  writeApplied(path, applied.filter((id) => id !== MIGRATION_ID))
  console.log(`Cleared ${MIGRATION_ID}`)
  console.log(`Workspace: ${workspace}`)
  console.log(`Stamp: ${path}`)
  console.log('Next Tie launch will run the migration once.')
  process.exit(0)
}

if (args.mark) {
  writeApplied(path, [...applied, MIGRATION_ID])
  console.log(`Marked ${MIGRATION_ID} applied`)
  console.log(`Stamp: ${path}`)
  process.exit(0)
}

console.log(`Migration: ${MIGRATION_ID}`)
console.log(`Workspace: ${workspace}`)
console.log(`Stamp: ${path}`)
console.log(`Applied: ${has ? 'yes' : 'no (pending — next Tie launch migrates once)'}`)
console.log('')
console.log('In-app: initialize() → runFileHrefMigrationOnce (stamp-gated).')
console.log('Not on every save/reload. Paste still rewrites file:/// immediately.')
