function heuristicTags({ title, markdown, existingTags, workspaceTags }) {
  const text = `${title}\n${markdown}`.toLowerCase()
  const scores = new Map()
  const add = (tag, score) => {
    const normalized = String(tag).trim()
    if (!normalized || normalized.length < 2 || normalized.length > 32) return
    if (existingTags.some((item) => String(item).toLowerCase() === normalized.toLowerCase())) return
    scores.set(normalized, (scores.get(normalized) ?? 0) + score)
  }
  for (const tag of workspaceTags) {
    if (text.includes(String(tag).toLowerCase())) add(tag, 10)
  }
  for (const match of markdown.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,32})/gu)) add(match[1], 12)
  for (const heading of markdown.matchAll(/^#{2,6}\s+(.+)$/gm)) {
    const value = heading[1].replace(/[。！？，、:：].*$/, '').trim()
    if (value.length >= 2) add(value, 6)
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, score]) => ({ tag, score, reasons: ['服务端提取'] }))
}

function parseModelTags(raw) {
  if (!raw) return []
  let parsed = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) } catch { return [] }
  }
  if (Array.isArray(parsed)) {
    return parsed.map((item) => ({
      tag: String(item.tag ?? item).trim(),
      score: Number(item.score ?? 10),
      reasons: Array.isArray(item.reasons) ? item.reasons.map(String) : ['AI 推荐'],
    })).filter((item) => item.tag)
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tags)) {
    return parseModelTags(parsed.tags)
  }
  return []
}

export async function suggestTags(input) {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  const baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
  if (!apiKey) return { tags: heuristicTags(input) }

  const prompt = [
    '你是知识库标签助手。请从页面标题和 Markdown 正文中提取 3-8 个简洁标签。',
    '返回 JSON：{"tags":[{"tag":"标签","score":10,"reasons":["原因"]}]}',
    `已有标签（不要重复）：${(input.existingTags ?? []).join('、') || '无'}`,
    `工作区标签（优先复用）：${(input.workspaceTags ?? []).slice(0, 40).join('、') || '无'}`,
    `标题：${input.title ?? ''}`,
    `正文：\n${String(input.markdown ?? '').slice(0, 8000)}`,
  ].join('\n\n')

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body?.error?.message ?? `OpenAI 请求失败（${response.status}）`
    throw new Error(message)
  }
  const content = body?.choices?.[0]?.message?.content
  const tags = parseModelTags(content)
  if (!tags.length) return { tags: heuristicTags(input), fallback: true }
  return { tags }
}
