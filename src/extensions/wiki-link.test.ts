import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { MarkdownManager } from '@tiptap/markdown'
import { WikiLink, wikiPageHref } from './wiki-link'

function wikiNodes(doc: JSONContent): JSONContent[] {
  return [
    ...(doc.type === 'wikiLink' ? [doc] : []),
    ...(doc.content ?? []).flatMap(wikiNodes),
  ]
}

describe('wiki page links', () => {
  const markdown = new MarkdownManager({ extensions: [StarterKit, WikiLink] })

  it('parses links from stored Markdown and preserves the syntax on save', () => {
    const source = '参见 [[产品文档]] 与 [[华为鸿蒙开发操作手册（Flutter）]]。'
    const doc = markdown.parse(source)
    expect(wikiNodes(doc).map((node) => node.attrs?.title)).toEqual(['产品文档', '华为鸿蒙开发操作手册（Flutter）'])
    expect(markdown.serialize(doc)).toBe(source)
    expect(wikiNodes(markdown.parse(markdown.serialize(doc)))).toEqual(wikiNodes(doc))
  })

  it('keeps exact titles, including Markdown punctuation and pipes', () => {
    const source = '[[映集 | 本地媒体管理系统]]、[[*设计* _稿_ `v2` & <概览>]]'
    const doc = markdown.parse(source)
    expect(wikiNodes(doc).map((node) => node.attrs?.title)).toEqual(['映集 | 本地媒体管理系统', '*设计* _稿_ `v2` & <概览>'])
    expect(markdown.serialize(doc)).toBe(source)
  })

  it('leaves escaped examples and code literal', () => {
    const source = '\\[\\[普通文本\\]\\]、`[[行内代码]]`\n\n```md\n[[代码块]]\n```'
    const doc = markdown.parse(source)
    expect(wikiNodes(doc)).toEqual([])
    expect(markdown.serialize(doc)).toBe(source)
  })

  it('keeps standard inline and reference links whose labels contain brackets', () => {
    for (const source of [
      '[[产品文档]](https://example.test)',
      '[[产品文档]][ref]\n\n[ref]: https://example.test',
      '[[产品文档]](tie://page/pg_product "产品")',
    ]) {
      const doc = markdown.parse(source)
      expect(wikiNodes(doc)).toEqual([])
      const text = doc.content?.[0]?.content?.[0]
      expect(text?.text).toBe('[产品文档]')
      expect(text?.marks?.[0]?.type).toBe('link')
      expect(text?.marks?.[0]?.attrs?.href).toMatch(/^(https:\/\/example\.test|tie:\/\/page\/pg_product)$/)
      expect(wikiNodes(markdown.parse(markdown.serialize(doc)))).toEqual([])
    }
    expect(wikiNodes(markdown.parse('[[产品文档]](不是链接')).map((node) => node.attrs?.title)).toEqual(['产品文档'])
  })

  it('does not create an inner anchor in link labels that Marked leaves as literal text', () => {
    const doc = markdown.parse('[see [[产品文档]]](https://example.test)')
    expect(wikiNodes(doc)).toEqual([])
    expect(doc.content?.[0]?.content?.map((node) => node.text).join('')).toBe('[see [[产品文档]]](https://example.test)')
    const linked = doc.content?.[0]?.content?.find((node) => node.marks?.some((mark) => mark.type === 'link'))
    expect(linked?.marks?.[0]?.attrs?.href).toBe('https://example.test')
  })

  it('keeps missing page references so they can resolve after pages load', () => {
    const doc = markdown.parse('[[稍后加载的页面]]')
    expect(markdown.serialize(doc)).toBe('[[稍后加载的页面]]')
    expect(wikiPageHref('稍后加载的页面', [])).toBeNull()
    expect(wikiPageHref('稍后加载的页面', [{ id: 'pg_later', title: '稍后加载的页面' }])).toBe('tie://page/pg_later')
  })

  it('resolves a unique exact title and skips deleted or ambiguous targets', () => {
    const pages = [
      { id: 'pg_a', title: '产品 A' },
      { id: 'pg_deleted', title: '产品 A', deletedAt: '2026-11-26' },
      { id: 'pg_b', title: '产品 B' },
      { id: 'pg_b_duplicate', title: '产品 B' },
    ]
    expect(wikiPageHref(' 产品 a ', pages)).toBe('tie://page/pg_a')
    expect(wikiPageHref('产品', pages)).toBeNull()
    expect(wikiPageHref('产品 B', pages)).toBeNull()
  })
})
