#!/usr/bin/env node
/**
 * 统一 bump 版本、更新 CHANGELOG、提交、打 tag 并推送到 origin。
 *
 * 用法:
 *   npm run release -- patch
 *   npm run release -- minor
 *   npm run release -- 1.0.2
 *   npm run release -- patch --all
 *   npm run release -- 1.0.2 --message "自动更新与发布流程" --dry-run
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const VERSION_FILES = [
  'package.json',
  'package-lock.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'backend/package.json',
  'packages/tie-mcp/package.json',
]

function printHelp() {
  console.log(`用法: npm run release -- <patch|minor|major|x.y.z> [选项]

选项:
  --all              提交全部改动（默认只提交版本相关文件）
  --message, -m      提交说明（默认 release: vX.Y.Z）
  --dry-run          只打印将要执行的操作
  --no-push          本地提交与打 tag，不 push
  --skip-changelog   不修改 CHANGELOG.md
  --allow-dirty      允许工作区有未暂存改动（与 --all 联用时默认允许）
  -h, --help         显示帮助

示例:
  npm run release -- patch --all
  npm run release -- 1.0.2 --all -m "桌面端自动更新"
`)
}

function parseArgs(argv) {
  const out = {
    bump: '',
    message: '',
    dryRun: false,
    noPush: false,
    skipChangelog: false,
    stageAll: false,
    allowDirty: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--no-push') out.noPush = true
    else if (arg === '--skip-changelog') out.skipChangelog = true
    else if (arg === '--all') out.stageAll = true
    else if (arg === '--allow-dirty') out.allowDirty = true
    else if (arg === '--message' || arg === '-m') out.message = argv[++i] || ''
    else if (arg.startsWith('--message=')) out.message = arg.slice('--message='.length)
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (!arg.startsWith('-') && !out.bump) out.bump = arg
    else {
      console.error(`未知参数: ${arg}`)
      printHelp()
      process.exit(1)
    }
  }
  if (!out.bump) {
    printHelp()
    process.exit(1)
  }
  if (out.stageAll) out.allowDirty = true
  return out
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim()
    throw new Error(detail ? `${cmd} ${args.join(' ')} 失败: ${detail}` : `${cmd} ${args.join(' ')} 失败`)
  }
  return (result.stdout || '').trim()
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
}

function writeJson(relativePath, data) {
  fs.writeFileSync(path.join(root, relativePath), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function readCurrentVersion() {
  return readJson('package.json').version
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version)
  if (!match) throw new Error(`无法解析当前版本号: ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function formatSemver(parts) {
  return `${parts.major}.${parts.minor}.${parts.patch}`
}

function resolveNextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+(?:-.+)?$/.test(bump)) return bump.replace(/^v/, '')
  const parts = parseSemver(current)
  switch (bump) {
    case 'major':
      return formatSemver({ major: parts.major + 1, minor: 0, patch: 0 })
    case 'minor':
      return formatSemver({ major: parts.major, minor: parts.minor + 1, patch: 0 })
    case 'patch':
      return formatSemver({ major: parts.major, minor: parts.minor, patch: parts.patch + 1 })
    default:
      throw new Error(`无效的版本参数: ${bump}（可用 patch / minor / major / x.y.z）`)
  }
}

function replaceOnce(content, pattern, replacement) {
  const next = content.replace(pattern, replacement)
  if (next === content) throw new Error(`未能替换: ${pattern}`)
  return next
}

function setPackageJsonVersion(relativePath, version) {
  const json = readJson(relativePath)
  json.version = version
  writeJson(relativePath, json)
}

function setPackageLockVersion(version) {
  const filePath = path.join(root, 'package-lock.json')
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  json.version = version
  if (json.packages?.['']?.version) json.packages[''].version = version
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
}

function setTauriConfVersion(version) {
  const filePath = path.join(root, 'src-tauri/tauri.conf.json')
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  json.version = version
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
}

function setCargoTomlVersion(version) {
  const filePath = path.join(root, 'src-tauri/Cargo.toml')
  const content = fs.readFileSync(filePath, 'utf8')
  fs.writeFileSync(
    filePath,
    replaceOnce(content, /^version = ".*"$/m, `version = "${version}"`),
    'utf8',
  )
}

function setCargoLockVersion(version) {
  const filePath = path.join(root, 'src-tauri/Cargo.lock')
  const content = fs.readFileSync(filePath, 'utf8')
  fs.writeFileSync(
    filePath,
    replaceOnce(content, /^name = "tie"\nversion = ".*"$/m, `name = "tie"\nversion = "${version}"`),
    'utf8',
  )
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10)
}

function updateChangelog(version) {
  const filePath = path.join(root, 'CHANGELOG.md')
  let content = fs.readFileSync(filePath, 'utf8')
  const date = todayIsoDate()
  const header = `## [${version}] - ${date}`
  if (content.includes(header)) return

  if (!content.includes('## [Unreleased]')) {
    throw new Error('CHANGELOG.md 缺少 ## [Unreleased] 段落')
  }

  content = content.replace('## [Unreleased]', `${header}\n\n## [Unreleased]`)
  content = content.replace(
    /^\[Unreleased\]: .+$/m,
    `[Unreleased]: https://github.com/sanyexieai/tie/compare/v${version}...HEAD\n[${version}]: https://github.com/sanyexieai/tie/releases/tag/v${version}`,
  )
  if (!content.includes(`[${version}]:`)) {
    content += `\n[${version}]: https://github.com/sanyexieai/tie/releases/tag/v${version}\n`
  }
  fs.writeFileSync(filePath, content, 'utf8')
}

function assertGitRepo() {
  run('git', ['rev-parse', '--is-inside-work-tree'], { capture: true })
}

function currentBranch() {
  return run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true })
}

function workingTreeClean() {
  const status = run('git', ['status', '--porcelain'], { capture: true })
  return status.length === 0
}

function tagExists(tag) {
  const local = run('git', ['tag', '-l', tag], { capture: true })
  if (local) return true
  try {
    const remote = run('git', ['ls-remote', '--tags', 'origin', tag], { capture: true })
    return remote.length > 0
  } catch {
    return false
  }
}

function bumpAllVersions(nextVersion) {
  setPackageJsonVersion('package.json', nextVersion)
  setPackageLockVersion(nextVersion)
  setTauriConfVersion(nextVersion)
  setCargoTomlVersion(nextVersion)
  setCargoLockVersion(nextVersion)
  setPackageJsonVersion('backend/package.json', nextVersion)
  setPackageJsonVersion('packages/tie-mcp/package.json', nextVersion)
}

function stageFiles(options, nextVersion) {
  const files = [...VERSION_FILES]
  if (!options.skipChangelog) files.push('CHANGELOG.md')
  if (options.stageAll) {
    run('git', ['add', '-A'])
    return
  }
  run('git', ['add', ...files])
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  assertGitRepo()

  const currentVersion = readCurrentVersion()
  const nextVersion = resolveNextVersion(currentVersion, options.bump)
  const tag = `v${nextVersion}`
  const branch = currentBranch()
  const commitMessage = options.message || `release: ${tag}`

  if (nextVersion === currentVersion) {
    throw new Error('新版本与当前版本相同')
  }
  if (tagExists(tag)) {
    throw new Error(`tag ${tag} 已存在（本地或 origin）`)
  }
  if (!options.allowDirty && !workingTreeClean()) {
    throw new Error('工作区有未提交改动。请加 --all 一并发布，或 --allow-dirty 仅 bump 版本文件。')
  }

  console.log(`版本: ${currentVersion} -> ${nextVersion}`)
  console.log(`tag: ${tag}`)
  console.log(`分支: ${branch}`)
  console.log(`提交: ${commitMessage}`)
  if (options.stageAll) console.log('将暂存: 全部改动')
  else console.log(`将暂存: ${VERSION_FILES.join(', ')}${options.skipChangelog ? '' : ', CHANGELOG.md'}`)

  if (options.dryRun) {
    console.log('\n[dry-run] 未修改文件，也未执行 git 操作。')
    return
  }

  bumpAllVersions(nextVersion)
  if (!options.skipChangelog) updateChangelog(nextVersion)

  stageFiles(options, nextVersion)

  const staged = run('git', ['diff', '--cached', '--name-only'], { capture: true })
  if (!staged) {
    throw new Error('没有可提交的改动')
  }

  run('git', ['commit', '-m', commitMessage])
  run('git', ['tag', tag])

  if (!options.noPush) {
    run('git', ['push', 'origin', branch])
    run('git', ['push', 'origin', tag])
    console.log(`\n已推送 ${branch} 与 ${tag}。GitHub Actions 将构建 Release。`)
  } else {
    console.log(`\n已在本地提交并创建 ${tag}（未 push）。`)
  }
}

try {
  main()
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
