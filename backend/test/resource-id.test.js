import assert from 'node:assert/strict'
import { it } from 'node:test'
import { assertResourceId } from '../src/resource-id.js'

it('accepts page and revision identifiers', () => {
  for (const value of ['pg_test', 'rev_2026-11-25T12-00-00-000Z', 'pg_1234567890abcdef']) {
    assert.equal(assertResourceId(value), value)
  }
})

it('rejects values that are not single resource identifiers', () => {
  for (const value of ['', 'bad/id', 'bad\\id', '.', '..', '/absolute', 'bad\u0000id', 'a'.repeat(81), null, 1]) {
    assert.throws(() => assertResourceId(value), (error) => error.status === 400)
  }
})
