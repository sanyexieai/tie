import { exchangeWithTie } from './mcp-http.js'
import { detectCli, loadSettings } from './settings.js'
import { store } from './store.js'
import { notifyWorkspace } from './live.js'

async function protectionCall(workspace, name, args, context) {
  const cli = detectCli(loadSettings().mcp.cliPath)
  if (!cli.ok) {
    const error = new Error(cli.error || '页面保护转换需要配置 tie-cli')
    error.status = 503
    throw error
  }
  const response = await exchangeWithTie(cli.path, ['--workspace', store.workspaceDir(workspace.id), 'mcp'], {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  }, 120000, {
    TIE_PAGE_PROTECTION_INTERNAL: '1',
    ...(context?.origin ? { TIE_CHANGE_ORIGIN: JSON.stringify(context.origin) } : {}),
  })
  const result = response.result
  if (result?.isError || !Array.isArray(result?.content)) {
    const message = result?.content?.find((item) => item.type === 'text')?.text || '页面保护转换失败'
    const error = new Error(message)
    error.status = /页面不存在/.test(message) ? 404 : /已更新|重新载入/.test(message) ? 409 : 400
    throw error
  }
  return JSON.parse(result.content.find((item) => item.type === 'text').text)
}

export function readPageProtection(workspace, pageId) {
  return protectionCall(workspace, 'tie_internal_protection_read', { id_or_title: pageId })
}

export async function replacePageProtection(workspace, pageId, body, context) {
  if (!body?.bundle || body.bundle.page?.id !== pageId) {
    const error = new Error('页面保护包与目标页面不一致')
    error.status = 400
    throw error
  }
  const page = await protectionCall(workspace, 'tie_internal_protection_replace', {
    bundle: body.bundle, expectedUpdatedAt: body.expectedUpdatedAt,
  }, context)
  notifyWorkspace(workspace.id)
  return page
}
