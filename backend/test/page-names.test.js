import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { filenameStem, repairUtf8Mojibake } from '../src/page-names.js'

describe('page names', () => {
  it('repairs utf-8 that was stored as latin-1 and uses that for the file name', () => {
    const broken = 'æµ\u{8b}è¯\u{95}MCP'
    assert.equal(repairUtf8Mojibake(broken), '测试MCP')
    assert.equal(filenameStem(broken, '无标题'), '测试MCP')
    assert.equal(filenameStem('欢迎使用 Tie', '无标题'), '欢迎使用 Tie')
  })
})
