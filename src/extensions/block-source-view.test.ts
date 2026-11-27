import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { MarkdownManager } from '@tiptap/markdown'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { applyBlockSource, startBlockSource, type BlockSourceSession } from '@/services/block-source'
import { blockSourceViewKey, createBlockSourceViewPlugin } from './block-source-view'

const extensions = [StarterKit]
const codec = new MarkdownManager({ extensions })
const schema = getSchema(extensions)

function setup() {
  const doc = schema.nodeFromJSON(codec.parse('before\n\ntarget\n\nafter'))
  const initial = EditorState.create({ doc, schema })
  const state = initial.apply(initial.tr.setSelection(TextSelection.create(doc, doc.child(0).nodeSize + 2)))
  let session: BlockSourceSession | null = startBlockSource(state, codec)
  const plugin = createBlockSourceViewPlugin({ getSession: () => session, getKey: () => 'stable-session', mount: () => {}, unmount: () => {} })
  return { state, plugin, session: session!, setSession: (next: BlockSourceSession | null) => { session = next } }
}

function decorations(plugin: ReturnType<typeof createBlockSourceViewPlugin>, state: EditorState) {
  return plugin.props.decorations!.call(plugin, state).find()
}

describe('inline block source presentation', () => {
  it('places one stable widget before the hidden target without changing its document', () => {
    const { state, plugin, session } = setup()
    const list = decorations(plugin, state)
    expect(list).toHaveLength(2)
    expect(list[0]!.from).toBe(session.from)
    expect(list[0]!.to).toBe(session.from)
    expect(list[0]!.spec).toMatchObject({ key: 'stable-session', side: -1, ignoreSelection: true })
    expect(list[0]!.spec.stopEvent(new Event('input'))).toBe(true)
    expect(list[1]!.from).toBe(session.from)
    expect(list[1]!.to).toBe(session.to)
    expect(state.doc.textContent).toBe('beforetargetafter')
  })

  it('hides each complete replacement block individually while retaining the widget key', () => {
    const { state, plugin, session, setSession } = setup()
    const applied = applyBlockSource(state, session, 'one\n\ntwo', codec)
    const next = state.apply(applied.transaction)
    setSession(applied.session)
    const list = decorations(plugin, next)
    expect(list).toHaveLength(3)
    expect(list[0]!.spec.key).toBe('stable-session')
    expect(list[1]!.from).toBe(applied.session.from)
    expect(list[1]!.to).toBe(list[2]!.from)
    expect(list[2]!.to).toBe(applied.session.to)
    expect(next.doc.textContent).toBe('beforeonetwoafter')
  })

  it('removes presentation decorations when the source session closes', () => {
    const { state, plugin, setSession } = setup()
    setSession(null)
    expect(decorations(plugin, state)).toEqual([])
  })

  it('can be installed as a real state plugin and refreshed without document changes', () => {
    const { state, plugin } = setup()
    const installed = state.reconfigure({ plugins: [plugin] })
    const refreshed = installed.apply(installed.tr.setMeta(blockSourceViewKey, true))
    expect(blockSourceViewKey.get(refreshed)).toBe(plugin)
    expect(refreshed.doc.eq(installed.doc)).toBe(true)
    expect(plugin.props.decorations!.call(plugin, refreshed).find()).toHaveLength(2)
  })
})
