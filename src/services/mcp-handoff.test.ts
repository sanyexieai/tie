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
    expect(text).toContain('先试后台 HTTP')
    expect(text).toContain('tie-mcp-connect')
    expect(text).toContain('C:\\tie\\tie.exe')
    expect(text).toContain('command "C:\\tie\\tie.exe"')
    expect(text).toContain('args ["mcp"]')
    expect(text).not.toContain('url "http://192.168.1.8:8787/mcp"')
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
    expect(text).toContain('本机 tie mcp')
    expect(text).toContain('command "C:\\tie\\tie.exe"')
    expect(text).toContain('args ["mcp"]')
    expect(text).toContain('TIE_WORKSPACE 为 "/notes"')
    expect(text).toContain('tie-mcp-connect')
    expect(text).toContain('当前没有可用的后台 HTTP')
    expect(text).not.toContain('127.0.0.1')
    expect(text).not.toContain('start:http')
  })
})
