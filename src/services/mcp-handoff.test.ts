import { describe, expect, it } from 'vitest'
import { buildMcpHandoffPrompt } from './mcp-handoff'

describe('buildMcpHandoffPrompt', () => {
  it('uses the backend MCP address when HTTP is available', () => {
    const text = buildMcpHandoffPrompt({
      mode: 'http',
      workspaceName: '我的知识库',
      workspacePath: 'C:\\notes',
      mcpUrl: 'http://192.168.1.8:8787/mcp',
      cliPath: 'C:\\tie\\tie.exe',
      clients: [{ id: 'cursor', label: 'Cursor', configPath: 'C:\\Users\\me\\.cursor\\mcp.json' }],
    })
    expect(text).toContain('http://192.168.1.8:8787/mcp')
    expect(text).toContain('GET http://192.168.1.8:8787/health')
    expect(text).toContain('tie-mcp-connect')
    expect(text).toContain('C:\\tie\\tie.exe')
    expect(text).toContain('url "http://192.168.1.8:8787/mcp"')
    expect(text).not.toContain('127.0.0.1:3927')
    expect(text).not.toContain('start:http')
  })

  it('uses the local tie CLI when the backend MCP is absent', () => {
    const text = buildMcpHandoffPrompt({
      mode: 'local',
      workspaceName: '笔记',
      workspacePath: '/notes',
      cliPath: 'C:\\tie\\tie.exe',
      clients: [],
    })
    expect(text).toContain('本机 tie 自己提供 MCP')
    expect(text).toContain('command "C:\\tie\\tie.exe"')
    expect(text).toContain('args ["mcp"]')
    expect(text).toContain('TIE_WORKSPACE 为 "/notes"')
    expect(text).toContain('tie-mcp-connect')
    expect(text).toContain('GET {后台}/health')
    expect(text).not.toContain('127.0.0.1')
    expect(text).not.toContain('start:http')
  })
})
