import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { MarkdownManager } from '@tiptap/markdown'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { WikiLink } from '@/extensions/wiki-link'
import { buildInlineSourceMap, type InlineSourceMap } from './inline-source-map'

const extensions = [StarterKit, WikiLink, Image.configure({ inline: true })]
const schema = getSchema(extensions)
const markdown = new MarkdownManager({ extensions })

function nodeFor(source: string) { return schema.nodeFromJSON(markdown.parse(source)).firstChild! }
function mapping(source: string, node = nodeFor(source)) { return buildInlineSourceMap(node, source, markdown.instance) }
function requiredMap(source: string) {
  const result = mapping(source)
  expect(result, source).not.toBeNull()
  return result!
}

function expectRoundtrip(map: InlineSourceMap, node: ProseMirrorNode) {
  for (let offset = 0; offset <= node.content.size; offset += 1) expect(map.toDocument(map.toSource(offset))).toBe(offset)
}

describe('inline Markdown source cursor mapping', () => {
  it('keeps Chinese and surrogate-pair offsets in the same UTF-16 coordinate system as ProseMirror', () => {
    const source = '中文🙂段落'
    const map = requiredMap(source)
    for (let offset = 0; offset <= source.length; offset += 1) {
      expect(map.toSource(offset)).toBe(offset)
      expect(map.toDocument(offset)).toBe(offset)
    }
    expect(map.toSource(-10)).toBe(0)
    expect(map.toSource(100)).toBe(source.length)
    expect(map.toDocument(-10)).toBe(0)
    expect(map.toDocument(100)).toBe(source.length)
  })

  it('places heading cursors after the marker and inside nested bold and italic text', () => {
    const source = '## 中文 **粗体 *斜体*** 结尾'
    const node = nodeFor(source)
    const map = requiredMap(source)
    expect(map.toSource(0)).toBe('## '.length)
    expect(map.toSource(node.textContent.indexOf('粗体'))).toBe(source.indexOf('粗体'))
    expect(map.toSource(node.textContent.indexOf('斜体') + 1)).toBe(source.indexOf('斜体') + 1)
    expect(map.toDocument(0)).toBe(0)
    expect(map.toDocument(source.indexOf('***'))).toBe(node.textContent.indexOf('斜体') + 2)
    expectRoundtrip(map, node)
  })

  it('supports star and underscore emphasis, strike and a final cursor before closing delimiters', () => {
    for (const source of ['***中文***', '__粗体__ _斜体_ ~~删除~~', '*一* **二** ~~三~~']) {
      const node = nodeFor(source)
      const map = requiredMap(source)
      expectRoundtrip(map, node)
      const lastText = node.textContent.at(-1)!
      expect(map.toSource(node.textContent.length)).toBe(source.lastIndexOf(lastText) + lastText.length)
    }
  })

  it('maps link labels with nested marks and URLs containing repeated label words or parentheses', () => {
    const source = '看 [**中文**标签](https://中文.test/a_(中文) "中文") 然后结束'
    const node = nodeFor(source)
    const map = requiredMap(source)
    expect(map.toSource(node.textContent.indexOf('中文') + 1)).toBe(source.indexOf('中文') + 1)
    expect(map.toSource(node.textContent.indexOf('标签'))).toBe(source.indexOf('标签'))
    expect(map.toDocument(source.indexOf('https://') + 8)).toBe(node.textContent.indexOf(' 然后'))
    expectRoundtrip(map, node)
  })

  it('retains escaped bracket positions even though Marked unescapes link labels before producing child tokens', () => {
    const source = '看 [a \\[b\\] \\* c](tie://page/pg_example)'
    const node = nodeFor(source)
    const map = requiredMap(source)
    expect(node.textContent).toBe('看 a [b] * c')
    expect(map.toSource(node.textContent.indexOf('['))).toBe(source.indexOf('\\['))
    expect(map.toSource(node.textContent.indexOf('b'))).toBe(source.indexOf('b'))
    expect(map.toSource(node.textContent.indexOf('*'))).toBe(source.indexOf('\\*'))
    expectRoundtrip(map, node)
  })

  it('uses the installed Markdown parser entity decoding without double-decoding escaped or numeric sequences', () => {
    const source = '甲 &amp; 乙 &lt; 丙 &amp;lt; 丁 &#x1F642; \\&amp;'
    const node = nodeFor(source)
    const map = requiredMap(source)
    expect(node.textContent).toBe('甲 & 乙 < 丙 &lt; 丁 &#x1F642; &amp;')
    expect(map.toSource(node.textContent.indexOf('&'))).toBe(source.indexOf('&amp;'))
    expect(map.toSource(node.textContent.indexOf('<'))).toBe(source.indexOf('&lt;'))
    expect(map.toSource(node.textContent.indexOf('&#x'))).toBe(source.indexOf('&#x'))
    expectRoundtrip(map, node)
  })

  it('maps code spans with tick delimiters, trimmed padding and normalized soft newlines', () => {
    for (const source of ['`` a ` b `` 与 `&amp;`', '`中文\n代码`', '`   `']) {
      const node = nodeFor(source)
      const map = requiredMap(source)
      expectRoundtrip(map, node)
    }
    expect(requiredMap('`` a ` b ``').toSource(0)).toBe(3)
    expect(requiredMap('`中文\n代码`').toSource(3)).toBe('`中文\n'.length)
  })

  it('supports autolinks and setext headings without confusing hidden link destinations with content', () => {
    for (const source of ['<https://example.test?a=1&amp;b=2>', 'www.example.test', '<user@example.test>', '中文标题\n===', '### 标题 ###']) {
      expectRoundtrip(requiredMap(source), nodeFor(source))
    }
    const map = requiredMap('### 标题 ###')
    expect(map.toSource(0)).toBe(4)
    expect(map.toSource(2)).toBe(6)
    expect(map.toDocument(10)).toBe(2)
  })

  it('maps empty paragraphs and headings without inventing a text position', () => {
    const paragraph = schema.nodes.paragraph!.create()
    expect(mapping('', paragraph)?.toSource(0)).toBe(0)
    const heading = schema.nodes.heading!.create({ level: 2 })
    expect(mapping('## ', heading)?.toSource(0)).toBe(3)
  })

  it('rejects atoms, hard breaks, unsupported marks and non-paragraph blocks', () => {
    for (const source of ['[[项目]]', '![图片](https://example.test/a.png)', '甲  \n乙', '> 引用', '- 列表', '```text\n代码\n```']) {
      expect(mapping(source), source).toBeNull()
    }
    const underline = schema.marks.underline!
    const node = schema.nodes.paragraph!.create(null, schema.text('下划线', [underline.create()]))
    expect(mapping('下划线', node)).toBeNull()
  })

  it('returns null when the visible text or block type cannot be verified', () => {
    expect(mapping('**不同**', nodeFor('**原文**'))).toBeNull()
    expect(mapping('## 原文', nodeFor('原文'))).toBeNull()
    expect(mapping('## 原文', nodeFor('### 原文'))).toBeNull()
    expect(mapping('原文\n\n第二段', nodeFor('原文'))).toBeNull()
    expect(mapping('<em>原文</em>', nodeFor('*原文*'))).toBeNull()
    expect(buildInlineSourceMap(nodeFor('原文'), '原文', { lexer: () => { throw new Error('unsupported tokenizer') } })).toBeNull()
  })
})
