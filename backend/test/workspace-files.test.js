import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'
import { getWorkspaceFile, upsertWorkspaceFileMeta } from '../src/workspace-files.js'
import { store } from '../src/store.js'
import { mergeFileMetadata, normalizeFileMeta, resourceFromMeta } from '../../shared/file-meta.js'

let root
let previous
const fileId = 'file_0123456789abcdef'
const workspaceId = 'workspace-device-test'
const stamp = '2026-01-01T00:00:00.000Z'
function binding(id, sourcePath, boundAt = stamp) {
  return { deviceId: id, deviceName: id, platform: 'linux', sourcePath,
    locator: { type: 'desktop', desktopPath: sourcePath, displayPath: sourcePath }, boundAt }
}
function meta(deviceBindings, updatedAt = stamp) {
  return { id: fileId, title: 'Source directory', kind: 'directory', mode: 'link', sourcePath: path.join(root, 'source'),
    storedPath: path.join(root, 'source'), deviceBindings, createdAt: stamp, updatedAt, preview: 'private source excerpt' }
}
beforeEach(() => {
  previous = process.env.TIE_DATA_DIR
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-device-files-test-'))
  process.env.TIE_DATA_DIR = root
  fs.mkdirSync(path.join(root, 'source'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  if (previous === undefined) delete process.env.TIE_DATA_DIR
  else process.env.TIE_DATA_DIR = previous
})

it('never marks a server-side same path as available and keeps device bindings without linked file previews', () => {
  const result = upsertWorkspaceFileMeta(workspaceId, meta({ dev_a: binding('dev_a', path.join(root, 'source')) }))
  assert.equal(result.bindingState, 'other-device')
  assert.equal(result.openPath, '')
  assert.equal(result.exists, false)
  assert.equal(result.sourcePath, '')
  assert.equal(result.storedPath, '')
  assert.equal(result.locator.desktopPath, undefined)
  assert.equal(result.locator.androidUri, undefined)
  assert.equal(result.deviceBindings.dev_a.deviceName, 'dev_a')
  const stored = JSON.parse(fs.readFileSync(path.join(store.workspaceDir(workspaceId), '.tie/files', fileId, 'meta.json'), 'utf8'))
  assert.equal(stored.preview, undefined)
  assert.equal(normalizeFileMeta({ ...stored, preview: 'legacy excerpt' }).preview, undefined)
})

it('merges independent device bindings and retains the other device through stale client rebinds', () => {
  const a = meta({ dev_a: binding('dev_a', '/device-a/source') })
  upsertWorkspaceFileMeta(workspaceId, a)
  const b = meta({ dev_b: binding('dev_b', '/device-b/source', '2026-01-01T00:00:01Z') }, '2026-01-01T00:00:01Z')
  upsertWorkspaceFileMeta(workspaceId, b)
  const reboundA = meta({ dev_a: binding('dev_a', '/device-a/new-source', '2026-01-01T00:00:02Z') }, '2026-01-01T00:00:02Z')
  upsertWorkspaceFileMeta(workspaceId, reboundA)
  upsertWorkspaceFileMeta(workspaceId, a)
  const result = getWorkspaceFile(workspaceId, fileId)
  assert.deepEqual(Object.keys(result.deviceBindings).sort(), ['dev_a', 'dev_b'])
  assert.equal(result.deviceBindings.dev_a.sourcePath, '/device-a/new-source')
  assert.equal(result.deviceBindings.dev_b.sourcePath, '/device-b/source')
  assert.deepEqual(mergeFileMetadata(a, b), mergeFileMetadata(b, a))
})

it('keeps legacy absolute paths unbound and portable copies available independently of device bindings', () => {
  upsertWorkspaceFileMeta(workspaceId, meta({}))
  const legacy = getWorkspaceFile(workspaceId, fileId)
  assert.equal(legacy.bindingState, 'unbound')
  assert.equal(legacy.openPath, '')
  assert.equal(legacy.exists, false)
  const copy = normalizeFileMeta({ ...meta({}), mode: 'copy', storedPath: `.tie/files/${fileId}/original.txt`, preview: 'copied excerpt' })
  assert.equal(copy.preview, 'copied excerpt')
  for (const storedPath of ['/outside/source', '../source', 'C:\\Source', 'C:Source']) {
    const invalid = resourceFromMeta({ ...copy, storedPath }, { exists: true })
    assert.equal(invalid.exists, false)
    assert.equal(invalid.openPath, '')
    assert.equal(invalid.storedPath, '')
  }
  assert.equal(resourceFromMeta(copy, { exists: true }).exists, true)
})
