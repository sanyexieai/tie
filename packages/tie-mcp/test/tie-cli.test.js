import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCliPageBackend, resolveTieCli } from '../src/tie-cli.js'

test('resolveTieCli returns null or an existing path', () => {
  const cli = resolveTieCli()
  if (cli) assert.ok(fs.existsSync(cli), cli)
})

test('cli backend write/search when tie binary available', async (t) => {
  const cli = resolveTieCli()
  if (!cli) {
    t.skip('tie CLI not built; run: cargo build -p tie-cli --manifest-path src-tauri/Cargo.toml')
    return
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tie-cli-mcp-'))
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true })
  const ws = createCliPageBackend(root, cli, {})

  const created = ws.writePage({
    title: 'CLI Bridge',
    markdown: 'hello from mcp bridge',
    tags: ['memory'],
  })
  assert.equal(created.created, true)
  assert.ok(created.page.id)

  const hits = ws.search({ query: 'bridge' })
  assert.ok(hits.some((item) => item.page.id === created.page.id))

  const got = ws.getById(created.page.id)
  assert.ok(got.markdown.includes('hello from mcp bridge'))
})
