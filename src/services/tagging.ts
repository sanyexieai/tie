const stopWords = new Set([
  '这个', '那个', '我们', '你们', '他们', '可以', '需要', '以及', '通过', '如果', '因为', '所以', '对于', '进行', '页面', '内容', '一个', '使用', '实现', '相关', '功能', '这里', '其中',
  'about', 'after', 'before', 'from', 'have', 'into', 'that', 'this', 'with', 'your',
])

function clean(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?(\[[^\]]*\])\([^)]*\)/g, '$1')
    .replace(/[`*_~>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isCandidate(value: string) {
  const tag = value.trim().replace(/^#\s*/, '')
  return tag.length >= 2 && tag.length <= 16 && !stopWords.has(tag.toLocaleLowerCase()) && !/^\d+$/.test(tag)
}

export function suggestTags(input: { title: string; markdown: string; existingTags: string[]; workspaceTags: string[] }) {
  const scores = new Map<string, number>()
  const add = (raw: string, score: number) => {
    const tag = raw.trim().replace(/^#\s*/, '')
    if (!isCandidate(tag) || input.existingTags.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) return
    scores.set(tag, (scores.get(tag) ?? 0) + score)
  }
  const text = clean(`${input.title}\n${input.markdown}`)
  const title = clean(input.title)

  for (const match of input.markdown.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,32})/gu)) add(match[1], 12)
  for (const heading of input.markdown.matchAll(/^#{2,6}\s+(.+)$/gm)) {
    const value = clean(heading[1]).replace(/[。！？，、:：].*$/, '')
    if (isCandidate(value)) add(value, 6)
  }
  for (const tag of input.workspaceTags) {
    const normalized = tag.toLocaleLowerCase()
    if (text.toLocaleLowerCase().includes(normalized)) add(tag, title.toLocaleLowerCase().includes(normalized) ? 9 : 4)
  }
  for (const word of text.match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,8}/g) ?? []) {
    if (title.includes(word)) add(word, 3)
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, 6)
    .map(([tag]) => tag)
}
