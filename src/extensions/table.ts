import { getExtensionField, type MarkdownExtensionSpec, type MarkdownToken, type MarkdownTokenizer } from '@tiptap/core'
import { Table } from '@tiptap/extension-table'

const parentTokenizer = getExtensionField<MarkdownTokenizer>(Table, 'markdownTokenizer')
const renderTable = getExtensionField<NonNullable<MarkdownExtensionSpec['renderMarkdown']>>(Table, 'renderMarkdown')

function escapeCellPipes(markdown: string) {
  return markdown.replace(/(\\*)\|/g, (match, slashes: string) => slashes.length % 2 ? match : `${slashes}\\|`)
}

function restoreTableRaw(src: string, token: MarkdownToken) {
  // GFM table rows are physical lines; counting a trailing newline as a row eats the next heading.
  const count = (token.rows as unknown[]).length + 2
  const lines = src.split('\n')
  return { ...token, raw: lines.slice(0, count).join('\n') + (lines.length > count ? '\n' : '') }
}

export const TieTable = Table.extend({
  renderMarkdown(node, helpers, context) {
    return renderTable(node, {
      ...helpers,
      renderChildren: (children, separator) => escapeCellPipes(helpers.renderChildren(children, separator)),
    }, context)
  },

  markdownTokenizer: {
    name: 'table',
    level: 'block',
    start: parentTokenizer.start,
    tokenize(src, tokens, helpers) {
      const lines = src.split('\n')
      if (lines.length < 2 || !/^[ \t|:]*-[ \t|:-]*$/.test(lines[1]!) || !lines[1]!.includes('|')) return undefined
      const blank = src.indexOf('\n\n')
      const candidate = blank < 0 ? src : src.slice(0, blank)
      const protectedSource = candidate.split('\n').map((line) => helpers.inlineTokens(line).map((token) => {
        const raw = token.raw ?? ''
        const explicitLink = token.type === 'wikiLink' || (token.type === 'link' && raw.startsWith('['))
        return explicitLink ? escapeCellPipes(raw) : raw
      }).join('')).join('\n')
      if (protectedSource === candidate) {
        const token = parentTokenizer.tokenize(src, tokens, helpers)
        return token?.type === 'table' && Array.isArray(token.rows) ? restoreTableRaw(src, token) : token
      }
      // Re-lex only the table candidate; escaped pipes make the recursive pass idempotent.
      const token = helpers.blockTokens(protectedSource)[0]
      return token?.type === 'table' && Array.isArray(token.rows) ? restoreTableRaw(src, token) : undefined
    },
  },
})
