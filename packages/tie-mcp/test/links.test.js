import assert from 'node:assert/strict'
import test from 'node:test'
import { rewriteLegacyWorkspaceHrefs } from '../src/links.js'

const sourceId = 'src_local_2e27348a0aa628a6'

test('rewriteLegacyWorkspaceHrefs adds sourceId and leaves assets alone', () => {
  const markdown = '[书](tie://file/file_abc)\n[稿](tie://path/docs/a.pdf)\n![](tie://asset/pg_x/a.png)'
  const rewritten = rewriteLegacyWorkspaceHrefs(markdown, sourceId)
  assert.ok(rewritten.includes(`tie://file/${encodeURIComponent(sourceId)}/file_abc`))
  assert.ok(rewritten.includes(`tie://path/${encodeURIComponent(sourceId)}/docs/a.pdf`))
  assert.ok(rewritten.includes('tie://asset/pg_x/a.png'))
  assert.equal(rewriteLegacyWorkspaceHrefs(rewritten, sourceId), rewritten)
})
