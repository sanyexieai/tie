import * as vault from './vault.js'
import { executeCredential } from './vault-executor.js'

const string = { type: 'string' }
export const vaultTools = [
  {
    name: 'tie_secret_search',
    description: '搜索当前工作区的凭据元数据，不读取明文。返回 secretRef、用途和目标摘要；凭据使用需本人在 /me/ 凭据库授权。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      query: string, service: string, environment: string,
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'tie_secret_use',
    description: '使用已获授权的凭据执行本人配置的固定 HTTP 操作。不会返回凭据明文，不能更换目标或请求内容；成功、失败、拒绝都会记录。缺少授权时请本人在 /me/ 凭据库授权当前 MCP 令牌或登录会话。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['secretRef'], properties: {
      secretRef: string, grantId: string,
    } },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'tie_secret_usage',
    description: '查看当前 MCP 令牌或登录会话在此工作区的凭据使用记录，只返回时间、目标引用、状态等元数据。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      secretRef: string, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    } },
    annotations: { readOnlyHint: true },
  },
]

export function isVaultTool(name) { return vaultTools.some(tool => tool.name === name) }

export async function callVaultTool(caller, name, argumentsValue) {
  const definition = vaultTools.find(tool => tool.name === name)
  const args = argumentsValue ?? {}
  if (name !== 'tie_secret_use' && (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !Object.hasOwn(definition.inputSchema.properties, key)))) {
    return failure('INVALID_ARGUMENTS', '凭据工具参数无效，不允许指定额外目标、请求内容或身份')
  }
  try {
    if (name !== 'tie_secret_use') vault.validateCaller(caller)
    if (name === 'tie_secret_search') {
      return success(vault.listSecrets(caller.userId, { ...args, workspaceId: caller.workspaceId }))
    }
    if (name === 'tie_secret_usage') {
      return success(vault.listUsage(caller.userId, { ...args, workspaceId: caller.workspaceId, principal: caller.principal }))
    }
    const authorized = vault.authorizeUse(caller, args)
    try {
      const result = await executeCredential({ target: authorized.secret.target, value: authorized.value })
      const ok = result.httpStatus >= 200 && result.httpStatus < 300
      vault.finishUse(authorized.eventId, { status: ok ? 'succeeded' : 'failed', httpStatus: result.httpStatus })
      const response = success({ ok, eventId: authorized.eventId, ...result })
      response.isError = !ok
      return response
    } catch (error) {
      vault.finishUse(authorized.eventId, { status: 'failed', reason: error.code || 'TARGET_FAILED' })
      return failure(error.code || 'TARGET_FAILED', '凭据操作未完成，请查看使用记录；未返回上游原文', { eventId: authorized.eventId })
    }
  } catch (error) {
    return failure(error.code || 'VAULT_ERROR', error.status < 500 ? error.message : '凭据服务暂时不可用', {
      ...(error.code === 'GRANT_REQUIRED' ? { approvalRequired: true, approvalPath: '/me/#vault', secretRef: args.secretRef, principal: caller.principal } : {}),
    })
  }
}

function success(value) { return { isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] } }
function failure(code, message, details = {}) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message, ...details }) }] }
}
