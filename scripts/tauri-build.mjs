#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

function applyLocalUpdaterKey(env) {
  if (env.TAURI_SIGNING_PRIVATE_KEY || env.TAURI_SIGNING_PRIVATE_KEY_PATH) return env
  const keyPath = path.join(os.homedir(), '.tauri', 'tie.key')
  if (!fs.existsSync(keyPath)) return env
  return { ...env, TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath }
}

const args = process.argv.slice(2)
const hasBundles = args.some((arg) => arg === '--bundles' || arg.startsWith('--bundles='))
const tauriArgs = ['tauri', 'build']
if (!hasBundles) tauriArgs.push('--bundles', defaultBundles())
tauriArgs.push(...args)

// Stage Rust `tie` CLI as Tauri externalBin sidecar for MCP (TIE_CLI).
const prepare = spawnSync('node', [path.join(root, 'scripts', 'prepare-tie-cli.mjs')], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if ((prepare.status ?? 1) !== 0) process.exit(prepare.status ?? 1)

const result = spawnSync('npx', tauriArgs, {
  cwd: root,
  env: applyLocalUpdaterKey(process.env),
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
process.exit(result.status ?? 1)
