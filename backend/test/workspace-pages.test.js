import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { closeLive } from '../src/live.js'
import { frontmatter, parsePage } from '../src/page-format.js'
import { store } from '../src/store.js'
import { getWorkspacePage, listWorkspacePages, listWorkspaceRevisions, readWorkspaceRevision, saveWorkspacePage } from '../src/workspace-pages.js'

const stamp = '2026-11-25T00:00:00.000Z'
const workspaceId = 'workspace-pages-test'
let dataDir
let previousDataDir

function demoPage(index, overrides = {}) {
  return {
    id: `pg_${String(index).padStart(4, '0')}`,
    title: `Page ${index}`,
    icon: '',
    parentId: index ? 'pg_0000' : null,
    sortKey: index,
    markdown: `# Page ${index}\n\nSynthetic content`,
    tags: [],
    createdAt: stamp,
    updatedAt: stamp,
    deletedAt: null,
    ...overrides,
  }
}

function writePlainPage(page, filename = `${page.title}.md`, metaName = page.id) {
  const filePath = path.join(store.workspacePagesDir(workspaceId), filename)
  const metaPath = path.join(store.workspaceDir(workspaceId), '.tie', 'meta', metaName)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.mkdirSync(path.dirname(metaPath), { recursive: true })
  fs.writeFileSync(filePath, page.markdown)
  fs.writeFileSync(metaPath, `tie_version: 1
id: ${page.id}
file: pages/${filename}
parent_id: ${page.parentId ?? ''}
sort_key: ${page.sortKey}
icon: ${page.icon}
title: ${page.title}
tags: [${page.tags.join(', ')}]
created_at: ${page.createdAt}
updated_at: ${page.updatedAt}
deleted_at: ${page.deletedAt ?? ''}
`)
  return { filePath, metaPath }
}

function countMetadataReads(context) {
  const metaDir = path.join(store.workspaceDir(workspaceId), '.tie', 'meta')
  const readFileSync = fs.readFileSync
  let reads = 0
  context.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (typeof file === 'string' && path.dirname(file) === metaDir) reads += 1
    return readFileSync(file, ...args)
  })
  return () => reads
}

describe('workspace page storage', { concurrency: 1 }, () => {
  beforeEach(() => {
    previousDataDir = process.env.TIE_DATA_DIR
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-workspace-pages-test-'))
    process.env.TIE_DATA_DIR = dataDir
  })

  afterEach(() => {
    closeLive()
    fs.rmSync(dataDir, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.TIE_DATA_DIR
    else process.env.TIE_DATA_DIR = previousDataDir
  })

  it('lists and saves hundreds of pages with linear metadata reads', (context) => {
    const pageCount = 300
    for (let index = 0; index < pageCount; index += 1) writePlainPage(demoPage(index))
    const metadataReads = countMetadataReads(context)

    const pages = listWorkspacePages(workspaceId)
    assert.equal(pages.length, pageCount)
    assert.equal(new Set(pages.map((page) => page.id)).size, pageCount)
    assert.ok(metadataReads() <= 3 * pageCount, `${metadataReads()} metadata reads for listing ${pageCount} pages`)

    const updated = demoPage(150, { markdown: '# Page 150\n\nChanged', updatedAt: '2026-11-25T00:00:01.000Z' })
    let before = metadataReads()
    assert.deepEqual(saveWorkspacePage(workspaceId, updated, stamp), updated)
    assert.ok(metadataReads() - before <= 4 * pageCount, 'updating a page must use linear metadata reads')
    assert.equal(getWorkspacePage(workspaceId, updated.id).markdown, updated.markdown)

    const added = demoPage(pageCount)
    before = metadataReads()
    assert.deepEqual(saveWorkspacePage(workspaceId, added), added)
    assert.ok(metadataReads() - before <= 6 * (pageCount + 1), 'locating a new page must use linear metadata reads')
    assert.equal(getWorkspacePage(workspaceId, added.id).markdown, added.markdown)
    assert.equal(listWorkspacePages(workspaceId).length, pageCount + 1)
  })

  it('observes external markdown and metadata changes between calls', () => {
    const initial = demoPage(0)
    const { filePath, metaPath } = writePlainPage(initial)
    assert.equal(listWorkspacePages(workspaceId)[0].updatedAt, stamp)

    const nextStamp = '2026-11-25T00:00:02.000Z'
    fs.writeFileSync(filePath, 'Externally changed body without a heading')
    fs.writeFileSync(metaPath, fs.readFileSync(metaPath, 'utf8')
      .replace('title: Page 0', 'title: External title')
      .replace('tags: []', 'tags: [external, changed]')
      .replace(`updated_at: ${stamp}`, `updated_at: ${nextStamp}`))
    const loaded = getWorkspacePage(workspaceId, initial.id)
    assert.equal(loaded.title, 'External title')
    assert.equal(loaded.markdown, 'Externally changed body without a heading')
    assert.deepEqual(loaded.tags, ['external', 'changed'])
    assert.equal(loaded.updatedAt, nextStamp)
    assert.throws(() => saveWorkspacePage(workspaceId, initial, stamp), { status: 409 })

    const renamedPath = path.join(path.dirname(filePath), 'Renamed.md')
    fs.renameSync(filePath, renamedPath)
    fs.writeFileSync(metaPath, fs.readFileSync(metaPath, 'utf8')
      .replace('file: pages/Page 0.md', 'file: pages/Renamed.md')
      .replace(`id: ${initial.id}`, 'id: pg_external'))
    assert.equal(getWorkspacePage(workspaceId, 'pg_external').title, 'External title')
    assert.deepEqual(listWorkspacePages(workspaceId).map((page) => page.id), ['pg_external'])

    fs.rmSync(metaPath)
    assert.deepEqual(listWorkspacePages(workspaceId), [])
  })

  it('keeps first file and metadata matches while migrating legacy frontmatter', () => {
    const first = demoPage(0)
    const firstFiles = writePlainPage(first, 'A.md', 'a-first')
    const shadow = demoPage(1, { id: 'pg_shadow' })
    const shadowFiles = writePlainPage(shadow, 'Unused.md', 'b-shadow')
    fs.rmSync(shadowFiles.filePath)
    fs.writeFileSync(shadowFiles.metaPath, fs.readFileSync(shadowFiles.metaPath, 'utf8').replace('pages/Unused.md', 'pages/A.md'))
    writePlainPage(demoPage(2, { id: first.id }), 'B.md', 'c-duplicate-id')
    const other = demoPage(3)
    writePlainPage(other, 'C.md', 'd-other')

    const legacy = demoPage(4, { title: 'Legacy', markdown: '# Legacy\n\nOld format', icon: '📝', tags: ['legacy'] })
    const legacyPath = path.join(store.workspacePagesDir(workspaceId), 'D-legacy.md')
    fs.writeFileSync(legacyPath, frontmatter(legacy).replace(/\n/g, '\r\n'))
    const legacyShadow = writePlainPage(demoPage(5), 'Unused.md', 'z-legacy-shadow')
    fs.rmSync(legacyShadow.filePath)
    fs.writeFileSync(legacyShadow.metaPath, fs.readFileSync(legacyShadow.metaPath, 'utf8').replace('pages/Unused.md', 'pages/D-legacy.md'))
    fs.writeFileSync(path.join(store.workspacePagesDir(workspaceId), 'Untracked.md'), '# Untracked')

    const pages = listWorkspacePages(workspaceId)
    assert.deepEqual(pages.map((page) => page.id), [first.id, other.id, legacy.id])
    assert.equal(pages[0].markdown, first.markdown)
    assert.equal(fs.readFileSync(firstFiles.filePath, 'utf8'), first.markdown)
    assert.equal(getWorkspacePage(workspaceId, first.id).markdown, first.markdown)
    assert.equal(fs.existsSync(legacyPath), false)
    assert.equal(fs.readFileSync(path.join(store.workspacePagesDir(workspaceId), 'Legacy.md'), 'utf8'), legacy.markdown)
    const migrated = getWorkspacePage(workspaceId, legacy.id)
    assert.equal(migrated.icon, legacy.icon)
    assert.deepEqual(migrated.tags, legacy.tags)
    assert.equal(migrated.createdAt, legacy.createdAt)
    assert.equal(migrated.updatedAt, legacy.updatedAt)
    assert.deepEqual(listWorkspacePages(workspaceId), pages)
  })

  it('archives the replaced content when restoring without a concurrency precondition', () => {
    const original = demoPage(0)
    saveWorkspacePage(workspaceId, original)
    assert.deepEqual(listWorkspaceRevisions(workspaceId, original.id), [])
    const changed = { ...original, markdown: '# Page 0\n\nChanged', updatedAt: '2026-11-25T00:00:01.000Z' }
    saveWorkspacePage(workspaceId, changed, original.updatedAt)
    const [revision] = listWorkspaceRevisions(workspaceId, original.id)
    const restored = readWorkspaceRevision(workspaceId, original.id, revision.id)
    saveWorkspacePage(workspaceId, { ...restored, updatedAt: '2026-11-25T00:00:02.000Z' })

    const snapshots = listWorkspaceRevisions(workspaceId, original.id)
      .map((item) => readWorkspaceRevision(workspaceId, original.id, item.id))
    assert.equal(snapshots.length, 2)
    assert.deepEqual(new Set(snapshots.map((page) => page.markdown)), new Set([original.markdown, changed.markdown]))
    assert.equal(getWorkspacePage(workspaceId, original.id).markdown, original.markdown)
  })

  for (const [field, value] of Object.entries({
    icon: '📚', parentId: 'pg_parent', sortKey: 9, tags: ['changed'],
    createdAt: '2026-11-24T00:00:00.000Z', deletedAt: '2026-11-25T00:00:01.000Z',
  })) {
    it(`archives a ${field}-only change without a concurrency precondition`, () => {
      const original = demoPage(0)
      saveWorkspacePage(workspaceId, original)
      saveWorkspacePage(workspaceId, { ...original, [field]: value, updatedAt: '2026-11-25T00:00:01.000Z' })
      const [revision] = listWorkspaceRevisions(workspaceId, original.id)
      assert.ok(revision)
      const previous = readWorkspaceRevision(workspaceId, original.id, revision.id)
      assert.deepEqual(previous[field], original[field])
      assert.deepEqual(getWorkspacePage(workspaceId, original.id)[field], value)
    })
  }

  it('archives a renamed page before relocating its Markdown file', () => {
    const original = demoPage(0)
    saveWorkspacePage(workspaceId, original)
    const renamed = { ...original, title: 'Renamed page', markdown: '# Renamed page\n\nSynthetic content' }
    saveWorkspacePage(workspaceId, renamed)
    const [revision] = listWorkspaceRevisions(workspaceId, original.id)
    assert.equal(readWorkspaceRevision(workspaceId, original.id, revision.id).title, original.title)
    assert.equal(getWorkspacePage(workspaceId, original.id).title, renamed.title)
  })

  it('does not create history for timestamp or source binding changes alone', () => {
    const original = demoPage(0)
    saveWorkspacePage(workspaceId, original)
    saveWorkspacePage(workspaceId, {
      ...original, icon: undefined, parentId: undefined, sortKey: undefined, tags: undefined, deletedAt: undefined,
      updatedAt: '2026-11-25T00:00:01.000Z', storageSourceId: 'backend:changed-binding',
    })
    assert.deepEqual(listWorkspaceRevisions(workspaceId, original.id), [])
  })

  it('rejects stale writes before archiving or replacing the current page', () => {
    const original = demoPage(0)
    saveWorkspacePage(workspaceId, original)
    const current = { ...original, markdown: '# Page 0\n\nOther device', updatedAt: '2026-11-25T00:00:01.000Z' }
    saveWorkspacePage(workspaceId, current, original.updatedAt)
    const historyBefore = listWorkspaceRevisions(workspaceId, original.id)
    assert.throws(() => saveWorkspacePage(workspaceId, original, original.updatedAt), { status: 409 })
    assert.deepEqual(listWorkspaceRevisions(workspaceId, original.id), historyBefore)
    assert.equal(getWorkspacePage(workspaceId, original.id).markdown, current.markdown)
  })

  it('preserves encrypted Markdown bytes and titles across storage, history and metadata edits', () => {
    const first = '-----BEGIN TIE ENCRYPTED MARKDOWN-----\n{"version":1,"ciphertext":"opaque-first"}\n-----END TIE ENCRYPTED MARKDOWN-----\n'
    const second = first.replace('opaque-first', 'opaque-second')
    const original = demoPage(0, { title: 'Deployment credentials', markdown: first, tags: ['private'] })
    saveWorkspacePage(workspaceId, original)
    assert.equal(getWorkspacePage(workspaceId, original.id).markdown, first)
    assert.equal(fs.readFileSync(path.join(store.workspacePagesDir(workspaceId), 'Deployment credentials.md'), 'utf8'), first)
    saveWorkspacePage(workspaceId, { ...original, markdown: second, updatedAt: '2026-11-25T00:00:01.000Z' })
    const [revision] = listWorkspaceRevisions(workspaceId, original.id)
    assert.equal(revision.title, original.title)
    const restored = readWorkspaceRevision(workspaceId, original.id, revision.id)
    assert.equal(restored.markdown, first)
    saveWorkspacePage(workspaceId, { ...restored, updatedAt: '2026-11-25T00:00:02.000Z' })
    saveWorkspacePage(workspaceId, { id: original.id, title: 'Renamed credentials', updatedAt: '2026-11-25T00:00:03.000Z' })
    const renamed = getWorkspacePage(workspaceId, original.id)
    assert.equal(renamed.markdown, first)
    assert.deepEqual(renamed.tags, ['private'])
    const count = listWorkspaceRevisions(workspaceId, original.id).length
    assert.throws(() => saveWorkspacePage(workspaceId, { ...renamed, markdown: 'ordinary replacement' }), { status: 409 })
    assert.equal(listWorkspaceRevisions(workspaceId, original.id).length, count)
    assert.equal(getWorkspacePage(workspaceId, original.id).markdown, first)
  })

  it('treats damaged encrypted wrappers as opaque rather than reading embedded headings', () => {
    const damaged = '-----BEGIN TIE ENCRYPTED MARKDOWN-----\r\n# Not a title\r\ntie://file/legacy\r\n'
    const original = demoPage(0, { title: 'Metadata title', markdown: damaged })
    const snapshot = frontmatter(original)
    assert.equal(parsePage(snapshot).markdown, damaged)
    assert.equal(parsePage(snapshot).title, original.title)
    saveWorkspacePage(workspaceId, original)
    assert.equal(getWorkspacePage(workspaceId, original.id).markdown, damaged)
    assert.equal(listWorkspacePages(workspaceId)[0].title, original.title)
  })
})
