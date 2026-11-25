#!/usr/bin/env node
/**
 * Build tie-cli and stage Tauri externalBin sidecars:
 *   src-tauri/binaries/tie-cli-<target-triple>[.exe]
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tauriDir = path.join(root, 'src-tauri')
const binariesDir = path.join(tauriDir, 'binaries')

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || `${cmd} failed`)
    process.exit(result.status ?? 1)
  }
  return String(result.stdout || '').trim()
}

const triple = run('rustc', ['-vV'])
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find((line) => line.startsWith('host:'))
  ?.slice('host:'.length)
  .trim()

if (!triple) {
  console.error('无法从 rustc -vV 解析 host triple')
  process.exit(1)
}

console.log(`[prepare-tie-cli] building tie-cli for ${triple}`)
run('cargo', ['build', '-p', 'tie-cli', '--release', '--manifest-path', path.join(tauriDir, 'Cargo.toml')])

const exeName = process.platform === 'win32' ? 'tie-cli.exe' : 'tie-cli'
const built = path.join(tauriDir, 'target', 'release', exeName)
if (!fs.existsSync(built)) {
  console.error(`未找到构建产物: ${built}`)
  process.exit(1)
}

fs.mkdirSync(binariesDir, { recursive: true })
const stagedName = process.platform === 'win32' ? `tie-cli-${triple}.exe` : `tie-cli-${triple}`
const staged = path.join(binariesDir, stagedName)
// Replace the file so a running CLI can keep its existing executable open.
const staging = `${staged}.tmp-${process.pid}`
fs.copyFileSync(built, staging)
try {
  fs.chmodSync(staging, 0o755)
} catch {
  /* windows */
}
fs.renameSync(staging, staged)
console.log(`[prepare-tie-cli] staged ${staged}`)
