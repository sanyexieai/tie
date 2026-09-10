#!/usr/bin/env node
/**
 * 本地发布前检查：对齐 CI `check` 里较关键、能拦住常见失败的步骤。
 * 由 `npm run release` 在 bump/commit/push 之前默认调用。
 *
 * 用法:
 *   npm run preflight
 *   node scripts/local-preflight.mjs --skip-backend
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = { skipBackend: false, skipMcp: false, skipCargo: true }
  for (const arg of argv) {
    if (arg === '--skip-backend') out.skipBackend = true
    else if (arg === '--skip-mcp') out.skipMcp = true
    else if (arg === '--cargo') out.skipCargo = false
    else if (arg === '--help' || arg === '-h') {
      console.log(`用法: npm run preflight [-- --skip-backend] [-- --skip-mcp] [-- --cargo]

默认执行:
  1. npm run check
  2. npm test
  3. npm run build
  4. npm run test:mcp
  5. npm run test:backend

--cargo 额外跑 cargo check（较慢，默认跳过）
`)
      process.exit(0)
    } else {
      console.error(`未知参数: ${arg}`)
      process.exit(1)
    }
  }
  return out
}

function run(label, cmd, args) {
  console.log(`\n▶ ${label}`)
  console.log(`  $ ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(`${label} 失败（exit ${result.status ?? 'null'}）`)
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  console.log('本地预检开始（通过后再允许 release push）')

  run('Typecheck frontend', 'npm', ['run', 'check'])
  run('Unit tests', 'npm', ['test'])
  run('Frontend production build', 'npm', ['run', 'build'])

  if (!options.skipMcp) {
    run('Tie MCP tests', 'npm', ['run', 'test:mcp'])
  }
  if (!options.skipBackend) {
    run('Backend API tests', 'npm', ['run', 'test:backend'])
  }
  if (!options.skipCargo) {
    run('Cargo check', 'cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml'])
  }

  console.log('\n✓ 本地预检通过')
}

try {
  main()
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
