import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { MarkdownManager } from '@tiptap/markdown'
import { TieTable } from './table'
import { WikiLink } from './wiki-link'

const markdown = new MarkdownManager({ extensions: [StarterKit.configure({ link: false }), Link, TieTable, TableRow, TableHeader, TableCell, WikiLink] })
function table(doc: JSONContent) { return doc.content!.find((node) => node.type === 'table')! }
function cell(doc: JSONContent) { return table(doc).content![1]!.content![1]!.content![0]!.content! }

describe('table Markdown pipe roundtrips', () => {
  it('preserves a complete wiki title containing a pipe through repeated saves', () => {
    let doc = markdown.parse('| 项目 | 链接 |\n| --- | --- |\n| A | [[映集 | 本地媒体管理系统]] |')
    const expected = table(doc)
    expect(expected.content![1]!.content).toHaveLength(2)
    expect(cell(doc)).toEqual([{ type: 'wikiLink', attrs: { title: '映集 | 本地媒体管理系统' } }])
    for (let round = 0; round < 3; round += 1) {
      const saved = markdown.serialize(doc)
      expect(saved).toContain('[[映集 \\| 本地媒体管理系统]]')
      doc = markdown.parse(saved)
      expect(table(doc)).toEqual(expected)
    }
  })

  it.each(['映集 | 本地媒体管理系统', '映集 \\| 本地媒体管理系统'])('preserves standard link labels from %s', (label) => {
    let doc = markdown.parse(`| 项目 | 链接 |\n| --- | --- |\n| A | [${label}](tie://page/pg_demo) |`)
    const expected = table(doc)
    expect(expected.content![1]!.content).toHaveLength(2)
    expect(cell(doc)[0]).toMatchObject({ text: '映集 | 本地媒体管理系统', marks: [{ type: 'link', attrs: { href: 'tie://page/pg_demo' } }] })
    for (let round = 0; round < 3; round += 1) {
      const saved = markdown.serialize(doc)
      expect(saved).toContain('[映集 \\| 本地媒体管理系统](tie://page/pg_demo)')
      doc = markdown.parse(saved)
      expect(table(doc)).toEqual(expected)
    }
  })
})
