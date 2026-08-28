import type { TagSuggestion } from '@/services/tagging'

export type AiTaggingMode = 'tie' | 'openai'

export interface AiTaggingConfig {
  enabled: boolean
  mode: AiTaggingMode
  endpoint: string
  apiKey?: string
  model?: string
}

const storageKey = 'tie-ai-tagging-v1'

function normalizeEndpoint(value: string) {
  return value.trim().replace(/\/+$/, '')
}

export function loadAiTaggingConfig(): AiTaggingConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '') as Partial<AiTaggingConfig>
    return {
      enabled: Boolean(saved.enabled),
      mode: saved.mode === 'openai' ? 'openai' : 'tie',
      endpoint: normalizeEndpoint(typeof saved.endpoint === 'string' ? saved.endpoint : ''),
      apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : undefined,
      model: typeof saved.model === 'string' ? saved.model : 'gpt-4o-mini',
    }
  } catch {
    return { enabled: false, mode: 'tie', endpoint: '', apiKey: undefined, model: 'gpt-4o-mini' }
  }
}

export function saveAiTaggingConfig(config: AiTaggingConfig) {
  localStorage.setItem(storageKey, JSON.stringify({
    enabled: config.enabled,
    mode: config.mode,
    endpoint: normalizeEndpoint(config.endpoint),
    apiKey: config.apiKey?.trim() || undefined,
    model: config.model?.trim() || 'gpt-4o-mini',
  }))
}

function normalizeSuggestions(raw: unknown): TagSuggestion[] {
  if (!raw || typeof raw !== 'object') return []
  const tags = (raw as { tags?: unknown }).tags
  if (!Array.isArray(tags)) return []
  return tags
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const tag = String((item as { tag?: unknown }).tag ?? '').trim()
      if (!tag) return null
      const score = Number((item as { score?: unknown }).score ?? 10)
      const reasonsRaw = (item as { reason?: unknown }).reason
      const reasons = Array.isArray((item as { reasons?: unknown }).reasons)
        ? (item as { reasons: unknown[] }).reasons.map((value) => String(value))
        : reasonsRaw ? [String(reasonsRaw)] : ['AI 推荐']
      return { tag, score, reasons }
    })
    .filter((item): item is TagSuggestion => Boolean(item))
}

async function suggestTagsViaTieBackend(
  config: AiTaggingConfig,
  input: { title: string; markdown: string; existingTags: string[]; workspaceTags: string[] },
  profile?: { endpoint: string; accessToken: string | null },
) {
  const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' })
  if (config.apiKey) headers.set('authorization', `Bearer ${config.apiKey}`)
  else if (profile?.accessToken) headers.set('authorization', `Bearer ${profile.accessToken}`)
  const response = await fetch(`${normalizeEndpoint(config.endpoint)}/api/v1/ai/suggest-tags`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'message' in body ? String(body.message) : `AI 标签请求失败（${response.status}）`
    throw new Error(message)
  }
  return normalizeSuggestions(body)
}

async function suggestTagsViaOpenAI(
  config: AiTaggingConfig,
  input: { title: string; markdown: string; existingTags: string[]; workspaceTags: string[] },
) {
  if (!config.apiKey) throw new Error('OpenAI 模式需要填写 API Key')
  const base = normalizeEndpoint(config.endpoint || 'https://api.openai.com/v1')
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          '从知识库页面提取 3-8 个标签，返回 JSON：{"tags":[{"tag":"标签","score":10,"reasons":["原因"]}]}',
          `已有标签（勿重复）：${input.existingTags.join('、') || '无'}`,
          `工作区标签（优先复用）：${input.workspaceTags.slice(0, 40).join('、') || '无'}`,
          `标题：${input.title}`,
          `正文：\n${input.markdown.slice(0, 8000)}`,
        ].join('\n\n'),
      }],
    }),
  })
  const body = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } } | null
  if (!response.ok) throw new Error(body?.error?.message ?? `OpenAI 请求失败（${response.status}）`)
  const content = body?.choices?.[0]?.message?.content
  if (!content) return []
  try {
    return normalizeSuggestions(JSON.parse(content))
  } catch {
    return normalizeSuggestions({ tags: JSON.parse(content) })
  }
}

export async function suggestTagsWithAi(
  config: AiTaggingConfig,
  input: { title: string; markdown: string; existingTags: string[]; workspaceTags: string[] },
  profile?: { endpoint: string; accessToken: string | null },
): Promise<TagSuggestion[]> {
  if (!config.enabled || !config.endpoint) return []
  if (config.mode === 'openai') return suggestTagsViaOpenAI(config, input)
  return suggestTagsViaTieBackend(config, input, profile)
}
