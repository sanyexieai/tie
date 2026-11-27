import { decodeHtmlEntities, type MarkdownToken } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export interface InlineSourceMap {
  toSource(documentContentOffset: number): number
  toDocument(sourceOffset: number): number
}

type SourceCharacter = { from: number; to: number }
type MappedText = { text: string; characters: SourceCharacter[] }
type MarkdownLexer = { lexer(source: string): unknown[] }

const supportedMarks = new Set(['bold', 'italic', 'strike', 'code', 'link'])

/** Positions are UTF-16 offsets inside a paragraph/heading, excluding its PM opening token. */
export function buildInlineSourceMap(node: ProseMirrorNode, source: string, lexer: MarkdownLexer): InlineSourceMap | null {
  if (!['paragraph', 'heading'].includes(node.type.name)) return null
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index)
    if (!child.isText || child.marks.some((mark) => !supportedMarks.has(mark.type.name))) return null
  }
  const raw: MappedText = {
    text: source,
    characters: Array.from({ length: source.length }, (_, index) => ({ from: index, to: index + 1 })),
  }
  let tokens: MarkdownToken[]
  try { tokens = lexer.lexer(source) as MarkdownToken[] } catch { return null }
  if (!tokens.length && node.type.name === 'paragraph' && !source && !node.textContent) return emptyMap(0)
  const token = tokens[0]
  if (tokens.length !== 1 || !token || token.type !== node.type.name || token.raw !== source || typeof token.text !== 'string') return null
  if (token.type === 'heading' && token.depth !== node.attrs.level) return null
  const content = blockContent(raw, token)
  if (!content || !token.tokens) return null
  const output: MappedText = { text: '', characters: [] }
  if (!appendTokens(output, content, token.tokens) || output.text !== node.textContent) return null
  const characters = output.characters
  if (!characters.length) return emptyMap(/^ {0,3}#{1,6}(?:[\t ]+|$)/.exec(source)?.[0].length ?? 0)
  return {
    toSource(offset) {
      const index = Math.max(0, Math.min(Math.trunc(offset), characters.length))
      // Prefer the next visible character at shared mark boundaries; keep a final cursor before closing markers.
      return index < characters.length ? characters[index]!.from : characters.at(-1)!.to
    },
    toDocument(offset) {
      const position = Math.max(0, Math.min(Math.trunc(offset), source.length))
      let low = 0
      let high = characters.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (characters[middle]!.from < position) low = middle + 1
        else high = middle
      }
      if (!low) return 0
      const previous = characters[low - 1]!
      if (position >= previous.to) return low
      return (position - previous.from) * 2 < previous.to - previous.from ? low - 1 : low
    },
  }
}

function emptyMap(sourcePosition: number): InlineSourceMap {
  return { toSource: () => sourcePosition, toDocument: () => 0 }
}

function slice(raw: MappedText, from: number, to = raw.text.length): MappedText {
  return { text: raw.text.slice(from, to), characters: raw.characters.slice(from, to) }
}

function blockContent(raw: MappedText, token: MarkdownToken): MappedText | null {
  const text = token.text!
  if (token.type === 'paragraph') {
    return raw.text.startsWith(text) && /^\n*$/.test(raw.text.slice(text.length)) ? slice(raw, 0, text.length) : null
  }
  const marker = /^ {0,3}#{1,6}(?:[\t ]+|$)/.exec(raw.text)
  if (marker) {
    const start = marker[0].length
    const end = start + text.length
    return raw.text.slice(start, end) === text && /^[\t ]*(?:#+[\t ]*)?\n*$/.test(raw.text.slice(end)) ? slice(raw, start, end) : null
  }
  return raw.text.startsWith(text) && /^\n {0,3}(?:=+|-+)[\t ]*\n*$/.test(raw.text.slice(text.length)) ? slice(raw, 0, text.length) : null
}

function appendTokens(output: MappedText, raw: MappedText, tokens: MarkdownToken[]): boolean {
  let cursor = 0
  for (const token of tokens) {
    if (typeof token.raw !== 'string' || raw.text.slice(cursor, cursor + token.raw.length) !== token.raw) return false
    const part = slice(raw, cursor, cursor + token.raw.length)
    cursor += token.raw.length
    if (token.type === 'text') {
      if (typeof token.text !== 'string' || token.text !== part.text) return false
      appendText(output, part, true)
    } else if (token.type === 'escape') {
      if (typeof token.text !== 'string' || part.text !== `\\${token.text}` || token.text.length !== 1) return false
      output.text += token.text
      output.characters.push({ from: part.characters[0]!.from, to: part.characters.at(-1)!.to })
    } else if (token.type === 'codespan') {
      const content = codeContent(part, token)
      if (!content) return false
      appendText(output, content, false)
    } else if (token.type === 'link') {
      const content = linkContent(part)
      if (!content || !token.tokens || !appendTokens(output, content, token.tokens)) return false
    } else if (token.type === 'strong' || token.type === 'em' || token.type === 'del') {
      const width = token.type === 'strong' ? 2 : token.type === 'em' ? 1 : /^~+/.exec(part.text)?.[0].length ?? 0
      const marker = part.text.slice(0, width)
      const content = slice(part, width, part.text.length - width)
      if (!width || !part.text.endsWith(marker) || content.text !== token.text || !token.tokens || !appendTokens(output, content, token.tokens)) return false
    } else return false
  }
  return cursor === raw.text.length
}

function appendText(output: MappedText, raw: MappedText, decode: boolean) {
  for (let index = 0; index < raw.text.length;) {
    const entity = decode && raw.text[index] === '&' ? /^(?:&lt;|&gt;|&quot;|&amp;)/.exec(raw.text.slice(index))?.[0] : undefined
    const width = entity?.length ?? 1
    output.text += entity ? decodeHtmlEntities(entity) : raw.text[index]
    output.characters.push({ from: raw.characters[index]!.from, to: raw.characters[index + width - 1]!.to })
    index += width
  }
}

function codeContent(raw: MappedText, token: MarkdownToken): MappedText | null {
  const marker = /^`+/.exec(raw.text)?.[0]
  if (!marker || !raw.text.endsWith(marker)) return null
  let content = slice(raw, marker.length, raw.text.length - marker.length)
  content.text = content.text.replace(/\n/g, ' ')
  if (content.text.startsWith(' ') && content.text.endsWith(' ') && /[^ ]/.test(content.text)) content = slice(content, 1, content.text.length - 1)
  return content.text === token.text ? content : null
}

function linkContent(raw: MappedText): MappedText | null {
  if (!raw.text.startsWith('[')) {
    return raw.text.startsWith('<') && raw.text.endsWith('>') ? slice(raw, 1, raw.text.length - 1) : raw
  }
  let depth = 1
  for (let index = 1; index < raw.text.length; index += 1) {
    if (raw.text[index] === '\\') { index += 1; continue }
    if (raw.text[index] === '[') depth += 1
    if (raw.text[index] !== ']' || --depth) continue
    const label = slice(raw, 1, index)
    const content: MappedText = { text: '', characters: [] }
    // Marked removes bracket escapes before tokenizing link labels; retain their original source spans.
    for (let offset = 0; offset < label.text.length; offset += 1) {
      if (label.text[offset] === '\\' && /[\[\]]/.test(label.text[offset + 1] ?? '')) {
        content.text += label.text[offset + 1]
        content.characters.push({ from: label.characters[offset]!.from, to: label.characters[offset + 1]!.to })
        offset += 1
      } else {
        content.text += label.text[offset]
        content.characters.push(label.characters[offset]!)
      }
    }
    return content
  }
  return null
}
