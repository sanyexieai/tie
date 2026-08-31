#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function defaultBundles() {
  switch (process.platform) {
    case 'win32':
      return 'msi,nsis'
    case 'darwin':
      return 'dmg,app'
    default:
      return 'deb,rpm'
  }
}

const args = process.argv.slice(2)
const hasBundles = args.some((arg) => arg === '--bundles' || arg.startsWith('--bundles='))
const tauriArgs = ['tauri', 'build']
if (!hasBundles) tauriArgs.push('--bundles', defaultBundles())
tauriArgs.push(...args)

const result = spawnSync('npx', tauriArgs, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
process.exit(result.status ?? 1)
