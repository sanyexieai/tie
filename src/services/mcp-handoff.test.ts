import { describe, expect, it } from 'vitest'
import { buildMcpHandoffPrompt } from './mcp-handoff'

describe('buildMcpHandoffPrompt', () => {
  it('renders the HTTP entry already selected by the client', () => {
    const text = buildMcpHandoffPrompt({
      mode: 'http',
      mcpUrl: 'http://192.168.1.8:8787/mcp',
    })
    expect(text).toContain('http://192.168.1.8:8787/mcp')
    expect(text).toContain('原生 HTTP MCP')
    expect(text).toContain('Authorization: Bearer <MCP token>')
    expect(text).toContain('transport: "http"')
    expect(text).not.toContain('tie-mcp-connect')
    expect(text).not.toContain('tie-upgrade-cli')
    expect(text).not.toMatch(/CLI|本机|本地|降级|tie_connection|\/health/)
    expect(text).not.toContain('args ["mcp"]')
    expect(text).not.toContain('先构建或安装')
    expect(text).not.toContain('127.0.0.1:3927')
    expect(text).not.toContain('start:http')
  })

  it('does not leak local paths into an HTTP handoff', () => {
    const input = {
      mode: 'http' as const,
      mcpUrl: 'https://example.test/mcp',
      workspaceName: '仅本机资料库', workspacePath: '/private/notes', cliPath: '/private/bin/tie',
      clients: [{ id: 'codex', label: 'Codex', configPath: '/private/agent/config.toml' }],
    }
    const text = buildMcpHandoffPrompt(input)
    expect(text).not.toContain('/private/')
    expect(text).not.toContain('仅本机资料库')
    expect(text).toContain('/me/')
  })

  it('renders the selected bridge without delegating routing to the Agent', () => {
    const input = {
      mode: 'local' as const, workspaceName: '笔记', workspacePath: '/notes',
      cliPath: '/bin/tie', mcpUrl: 'https://example.test/mcp',
      clients: [{ id: 'codex', label: 'Codex' }],
    }
    const text = buildMcpHandoffPrompt(input)
    expect(text).toContain('command "/bin/tie"')
    expect(text).toContain('args ["mcp"]')
    expect(text).toContain('由此 MCP 进程处理')
    expect(text).not.toMatch(/https:\/\/example.test|\/health|tie_connection|confirm_local|先试|不通再/)
  })

  it('uses the local tie CLI when the backend MCP is absent', () => {
    const text = buildMcpHandoffPrompt({
      mode: 'local',
      workspaceName: '笔记',
      workspacePath: '/notes',
      cliPath: 'C:\\tie\\tie.exe',
      clients: [],
    })
    expect(text).toContain('本机 MCP 桥接')
    expect(text).toContain('command "C:\\tie\\tie.exe"')
    expect(text).toContain('args ["mcp"]')
    expect(text).toContain('TIE_WORKSPACE 为 "/notes"')
    expect(text).not.toContain('tie-mcp-connect')
    expect(text).not.toContain('当前没有可用的后台 HTTP')
    expect(text).not.toContain('127.0.0.1')
    expect(text).not.toContain('start:http')
  })
})
