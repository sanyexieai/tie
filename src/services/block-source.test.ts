import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { MarkdownManager } from '@tiptap/markdown'
import { history, undo } from '@tiptap/pm/history'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { TieTable } from '@/extensions/table'
import { WikiLink } from '@/extensions/wiki-link'
import { applyBlockSource, mapBlockSource, startBlockSource } from './block-source'

const extensions = [StarterKit, TieTable, TableRow, TableHeader, TableCell, TaskList, TaskItem, WikiLink]
const schema = getSchema(extensions)
const codec = new MarkdownManager({ extensions })

function stateAt(markdown: string, text: string, offset = 0) {
  const doc = schema.nodeFromJSON(codec.parse(markdown))
  let position = 1
  doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes(text)) position = pos + node.text.indexOf(text) + offset
  })
  const state = EditorState.create({ doc, schema, plugins: [history()] })
  return state.apply(state.tr.setSelection(TextSelection.create(doc, position)))
}

function source(state: EditorState) { return codec.serialize(state.doc.toJSON()) }

describe('current block Markdown editing', () => {
  it('does not reinterpret unchanged literal HTML text when a source block is saved', () => {
    const text = '<span>literal text</span>'
    const doc = schema.nodes.doc!.create(null, schema.nodes.paragraph!.create(null, schema.text(text)))
    const state = EditorState.create({ doc, schema, plugins: [history()] })
    const session = startBlockSource(state, codec)!
    const applied = applyBlockSource(state, session, session.markdown, codec)
    expect(applied.transaction.docChanged).toBe(false)
    expect(applied.transaction.doc.textContent).toBe(text)
  })

  it('serializes the heading and maps a cursor inside a formatted span to its Markdown', () => {
    const state = stateAt('before\n\n## Hello **world** [Tie](tie://page/pg_a)\n\nafter', 'world', 2)
    const session = startBlockSource(state, codec)!
    expect(session.nodeType).toBe('heading')
    expect(session.markdown).toBe('## Hello **world** [Tie](tie://page/pg_a)')
    expect(session.initialSelection.from).toBe('## Hello **wo'.length)
    expect(session.initialSelection.to).toBe(session.initialSelection.from)
  })

  it('places a heading-start cursor after its marker and a link cursor inside its label', () => {
    const heading = startBlockSource(stateAt('## Heading', 'Heading'), codec)!
    expect(heading.initialSelection.from).toBe('## '.length)
    const link = startBlockSource(stateAt('Click [example](https://example.test)', 'example', 3), codec)!
    expect(link.initialSelection.from).toBe('Click [exa'.length)
  })

  it('replaces one block with multiple blocks without changing its neighbors', () => {
    let state = stateAt('before\n\n**target**\n\nafter', 'target')
    const session = startBlockSource(state, codec)!
    const applied = applyBlockSource(state, session, '## New title\n\nA [page](tie://page/pg_example).', codec)
    state = state.apply(applied.transaction)
    expect(source(state)).toBe('before\n\n## New title\n\nA [page](tie://page/pg_example).\n\nafter')
    expect(applied.session.nodeType).toBe('doc')
    expect(applied.session.to - applied.session.from).toBe(state.doc.child(1).nodeSize + state.doc.child(2).nodeSize)
  })

  it('keeps nested lists as a complete Markdown block instead of losing their parents', () => {
    let state = stateAt('before\n\n- parent\n  - nested\n- sibling\n\nafter', 'nested')
    const session = startBlockSource(state, codec)!
    expect(session.nodeType).toBe('bulletList')
    expect(session.markdown).toContain('parent')
    expect(session.markdown).toContain('sibling')
    state = state.apply(applyBlockSource(state, session, '- parent\n  - changed\n- sibling', codec).transaction)
    expect(state.doc.child(1).type.name).toBe('bulletList')
    expect(source(state)).toBe('before\n\n- parent\n  - changed\n- sibling\n\nafter')
  })

  it('edits complete tables and retains wiki links and cells with pipes', () => {
    let state = stateAt('before\n\n| Name | Entry |\n| --- | --- |\n| A | [[Project | docs]] |\n\nafter', 'A')
    const session = startBlockSource(state, codec)!
    expect(session.nodeType).toBe('table')
    const next = session.markdown.replace('| A ', '| B ')
    state = state.apply(applyBlockSource(state, session, next, codec).transaction)
    expect(state.doc.child(1).content.child(1).childCount).toBe(2)
    expect(source(state)).toContain('[[Project \\| docs]]')
    expect(state.doc.lastChild?.textContent).toBe('after')
  })

  it('treats task lists, quotes and fenced code as complete blocks', () => {
    for (const [markdown, text, type] of [
      ['- [ ] first\n- [x] second', 'second', 'taskList'],
      ['> first\n>\n> second', 'second', 'blockquote'],
      ['```md\n**literal**\n```', 'literal', 'codeBlock'],
    ]) {
      const state = stateAt(`before\n\n${markdown}\n\nafter`, text!)
      const session = startBlockSource(state, codec)!
      expect(session.nodeType).toBe(type)
      expect(applyBlockSource(state, session, session.markdown, codec).session.original.eq(session.original)).toBe(true)
    }
  })

  it('uses an empty paragraph when the entire block is cleared', () => {
    let state = stateAt('before\n\ntarget\n\nafter', 'target')
    state = state.apply(applyBlockSource(state, startBlockSource(state, codec)!, '', codec).transaction)
    expect(state.doc.childCount).toBe(3)
    expect(state.doc.child(1).type.name).toBe('paragraph')
    expect(state.doc.child(1).content.size).toBe(0)
    expect(state.doc.lastChild?.textContent).toBe('after')
  })

  it('rebases after a commit so subsequent input still replaces only the edited range', () => {
    let state = stateAt('before\n\ntarget\n\nafter', 'target')
    let session = startBlockSource(state, codec)!
    for (const markdown of ['one\n\ntwo', 'one\n\n**changed**', 'finished']) {
      const applied = applyBlockSource(state, session, markdown, codec)
      state = state.apply(applied.transaction)
      session = applied.session
      expect(state.doc.firstChild?.textContent).toBe('before')
      expect(state.doc.lastChild?.textContent).toBe('after')
    }
    expect(source(state)).toBe('before\n\nfinished\n\nafter')
  })

  it('maps insertions before the target instead of replacing the new neighbor', () => {
    let state = stateAt('before\n\ntarget\n\nafter', 'target')
    let session = startBlockSource(state, codec)!
    const transaction = state.tr.insert(0, schema.nodes.paragraph!.create(null, schema.text('new neighbor')))
    session = mapBlockSource(session, transaction)
    state = state.apply(transaction)
    expect(session.conflicted).toBe(false)
    state = state.apply(applyBlockSource(state, session, 'changed', codec).transaction)
    expect(source(state)).toBe('new neighbor\n\nbefore\n\nchanged\n\nafter')
  })

  it('allows a concurrent edit outside the current block', () => {
    let state = stateAt('before\n\ntarget\n\nafter', 'target')
    let session = startBlockSource(state, codec)!
    const transaction = state.tr.insertText('!', state.doc.content.size - 1)
    session = mapBlockSource(session, transaction)
    state = state.apply(transaction)
    expect(session.conflicted).toBe(false)
    state = state.apply(applyBlockSource(state, session, 'changed', codec).transaction)
    expect(source(state)).toBe('before\n\nchanged\n\nafter!')
  })

  it('rejects a target changed by another transaction while retaining its original source', () => {
    let state = stateAt('before\n\ntarget\n\nafter', 'target')
    let session = startBlockSource(state, codec)!
    const transaction = state.tr.insertText('remote ', session.from + 1)
    session = mapBlockSource(session, transaction)
    state = state.apply(transaction)
    expect(session.conflicted).toBe(true)
    expect(session.markdown).toBe('target')
    expect(() => applyBlockSource(state, session, 'local draft', codec)).toThrow('源码草稿仍保留')
    expect(source(state)).toContain('remote target')
  })

  it('detects a whole-document replacement without guessing a different target', () => {
    let state = stateAt('before\n\ntarget\n\nafter', 'target')
    let session = startBlockSource(state, codec)!
    const replacement = schema.nodeFromJSON(codec.parse('remote')).content
    const transaction = state.tr.replaceWith(0, state.doc.content.size, replacement)
    session = mapBlockSource(session, transaction)
    state = state.apply(transaction)
    expect(session.conflicted).toBe(true)
    expect(() => applyBlockSource(state, session, 'draft', codec)).toThrow('源码草稿仍保留')
  })

  it('undoes a source application as one operation and keeps an earlier neighboring edit', () => {
    let state = stateAt('before\n\ntarget\n\nafter', 'target')
    state = state.apply(state.tr.insertText('!', 1))
    const session = startBlockSource(state, codec)!
    state = state.apply(applyBlockSource(state, session, '**replacement**\n\nsecond paragraph', codec).transaction)
    expect(undo(state, (transaction) => { state = state.apply(transaction) })).toBe(true)
    expect(source(state)).toBe('!before\n\ntarget\n\nafter')
  })

  it('does not invent an undo entry when an unchanged block is applied', () => {
    let state = stateAt('before\n\ntarget\n\nafter', 'target')
    const session = startBlockSource(state, codec)!
    state = state.apply(applyBlockSource(state, session, session.markdown, codec).transaction)
    expect(undo(state, (transaction) => { state = state.apply(transaction) })).toBe(false)
  })
})
