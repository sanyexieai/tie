import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mcpEnabledFromEnv, resolveMcpLaunch } from '../src/mcp-http.js'

describe('mcp http launch option', () => {
  it('stays off unless explicitly selected', () => {
    assert.equal(mcpEnabledFromEnv({}), false)
    assert.equal(mcpEnabledFromEnv({ TIE_MCP_HTTP: '0' }), false)
    assert.equal(mcpEnabledFromEnv({ TIE_MCP_HTTP: '1' }), true)
  })

  it('refuses to start without a workspace and tie CLI', () => {
    const launch = resolveMcpLaunch({ TIE_MCP_HTTP: '1' })
    assert.equal(launch.ok, false)
    assert.match(launch.error, /TIE_WORKSPACE/)
  })
})
