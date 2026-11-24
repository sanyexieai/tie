#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Cursor / IDE terminals often keep a stale PATH; prepend known cargo locations. */
function ensureCargoOnPath(env = process.env) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path'
  const current = String(env[pathKey] || '')
  const parts = current.split(path.delimiter).filter(Boolean)
  const extras = []

  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
    for (const dir of fs.readdirSync(programFiles, { withFileTypes: true })) {
      if (!dir.isDirectory() || !/^Rust\b/i.test(dir.name)) continue
      const bin = path.join(programFiles, dir.name, 'bin')
      if (fs.existsSync(path.join(bin, 'cargo.exe'))) extras.push(bin)
    }
    const cargoHomeBin = path.join(os.homedir(), '.cargo', 'bin')
    if (fs.existsSync(path.join(cargoHomeBin, 'cargo.exe'))) extras.push(cargoHomeBin)
  } else {
    const cargoHomeBin = path.join(os.homedir(), '.cargo', 'bin')
    if (fs.existsSync(path.join(cargoHomeBin, 'cargo'))) extras.push(cargoHomeBin)
  }

  const merged = [...extras, ...parts]
  const seen = new Set()
  env[pathKey] = merged
    .filter((entry) => {
      const key = entry.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join(path.delimiter)
  return env
}

if (process.platform === 'linux') {
  const setup = path.join(root, 'scripts', 'setup-linux-dev-icon.sh')
  const result = spawnSync('bash', [setup], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const env = ensureCargoOnPath({ ...process.env })
const cargoCheck = spawnSync('cargo', ['--version'], {
  env,
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
if (cargoCheck.status !== 0) {
  console.error(
    "找不到 cargo。请安装 Rust，或把 cargo 所在目录加入 PATH 后重开 Cursor。\n" +
      "Windows 常见路径：C:\\Program Files\\Rust stable MSVC *\\bin",
  )
  process.exit(1)
}

const result = spawnSync('npx', ['tauri', 'dev', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env,
})
process.exit(result.status ?? 1)
