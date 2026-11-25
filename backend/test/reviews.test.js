import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeReviewEntries } from '../src/reviews.js'

test('review merge keeps both clients and lets a decision win', () => {
  const merged = mergeReviewEntries(
    [{ id: 'rv_a', kind: 'version', status: 'open', actor: '另一端', at: '2026-01-01T00:00:00.000Z', markdown: '甲' }],
    [
      { id: 'rv_a', kind: 'version', status: 'final', actor: '甲机', at: '2026-01-01T00:00:00.000Z', markdown: '甲' },
      { id: 'rv_b', kind: 'version', status: 'dropped', actor: '乙机', at: '2026-01-02T00:00:00.000Z', markdown: '乙' },
      { id: 'op_1', kind: 'opinion', status: 'open', actor: '甲机', at: '2026-01-03T00:00:00.000Z', body: '这里改一下' },
    ],
  )
  assert.equal(merged.find((item) => item.id === 'rv_a').status, 'final')
  assert.equal(merged.find((item) => item.id === 'rv_a').actor, '甲机')
  assert.equal(merged.find((item) => item.id === 'rv_b').markdown, '乙')
  assert.equal(merged.find((item) => item.id === 'op_1').body, '这里改一下')
})
