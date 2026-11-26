import { Node, mergeAttributes, type MarkdownLexerConfiguration } from '@tiptap/core'

type PageTarget = { id: string; title: string; deletedAt?: string | null }

let parsingStandardLink = false

function standardLinkToken(src: string, lexer: MarkdownLexerConfiguration) {
  // The supplied lexer retains reference definitions; suppress our tokenizer during this synchronous probe.
  parsingStandardLink = true
  try {
    return lexer.inlineTokens(src)[0]
  } finally {
    parsingStandardLink = false
  }
}

export function wikiPageHref(title: string, pages: readonly PageTarget[]): string | null {
  const key = title.trim().toLocaleLowerCase()
  const matches = pages.filter((page) => !page.deletedAt && page.title.toLocaleLowerCase() === key)
  return matches.length === 1 ? `tie://page/${matches[0]!.id}` : null
}

export const WikiLink = Node.create<{ resolveHref: (title: string) => string | null }>({
  // Keep the reference as a node so Markdown serialization does not escape its brackets.
  name: 'wikiLink',
  inline: true,
  group: 'inline',
  atom: true,

  addOptions() {
    return { resolveHref: () => null }
  },

  addAttributes() {
    return {
      title: {
        default: '',
        rendered: false,
        parseHTML: (element) => element.getAttribute('data-wiki-title'),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'a[data-wiki-title]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const title = node.attrs.title as string
    const href = this.options.resolveHref(title)
    return ['a', mergeAttributes(HTMLAttributes, {
      'data-wiki-title': title,
      href,
      title: href ? title : `未找到唯一页面：${title}`,
      class: href ? null : 'wiki-link-unresolved',
    }), title]
  },

  renderText({ node }) {
    return node.attrs.title
  },

  markdownTokenizer: {
    name: 'wikiLink',
    level: 'inline',
    start: (src) => src.indexOf('[['),
    tokenize(src, _tokens, lexer) {
      if (parsingStandardLink) return undefined
      const match = /^\[\[([^\[\]\r\n]+)\]\]/.exec(src)
      if (!match) {
        if (/^\[[^\[\]\r\n]+\[\[/.test(src)) {
          const standard = standardLinkToken(src, lexer)
          // Marked leaves deeply nested link labels as text; do not turn their inner brackets into another anchor.
          if (standard?.type === 'text' && standard.raw?.endsWith('](')) return standard
        }
        return undefined
      }
      if (!match[1]!.trim()) return undefined
      if (/^[([]/.test(src.slice(match[0].length))) {
        const standard = standardLinkToken(src, lexer)
        if (standard?.type === 'link') return standard
      }
      return { type: 'wikiLink', raw: match[0], text: match[1] }
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode('wikiLink', { title: token.text })
  },

  renderMarkdown(node) {
    return `[[${node.attrs?.title ?? ''}]]`
  },
})
