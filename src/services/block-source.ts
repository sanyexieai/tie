import type { JSONContent } from '@tiptap/core'
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { Selection, type EditorState, type Transaction } from '@tiptap/pm/state'

export interface BlockSourceCodec {
  parse(markdown: string): JSONContent
  serialize(document: JSONContent): string
}

export interface BlockSourceSelection {
  from: number
  to: number
}

export interface BlockSourceSession {
  from: number
  to: number
  nodeType: string
  label: string
  original: Fragment
  markdown: string
  initialSelection: BlockSourceSelection
  conflicted: boolean
}

const blockLabels: Record<string, string> = {
  paragraph: '段落',
  heading: '标题',
  bulletList: '无序列表（完整列表）',
  orderedList: '有序列表（完整列表）',
  taskList: '待办事项（完整列表）',
  blockquote: '引用（完整引用）',
  codeBlock: '代码块',
  table: '表格（完整表格）',
  horizontalRule: '分割线',
  image: '图片',
}

export function startBlockSource(state: EditorState, codec: BlockSourceCodec): BlockSourceSession | null {
  if (!state.doc.childCount) return null
  const index = Math.min(state.selection.$from.index(0), state.doc.childCount - 1)
  let from = 0
  for (let offset = 0; offset < index; offset += 1) from += state.doc.child(offset).nodeSize
  const node = state.doc.child(index)
  const original = Fragment.from(node)
  const markdown = serializeFragment(original, codec)
  return {
    from,
    to: from + node.nodeSize,
    nodeType: node.type.name,
    label: blockLabels[node.type.name] ?? node.type.name,
    original,
    markdown,
    initialSelection: {
      from: sourceOffset(node, markdown, state.selection.from - from - 1, codec),
      to: sourceOffset(node, markdown, state.selection.to - from - 1, codec),
    },
    conflicted: false,
  }
}

export function mapBlockSource(session: BlockSourceSession, transaction: Transaction): BlockSourceSession {
  if (!transaction.docChanged) return session
  const from = transaction.mapping.map(session.from, 1)
  const to = transaction.mapping.map(session.to, -1)
  return {
    ...session,
    from,
    to,
    // A remote setContent has no useful character mapping. Retain the source buffer rather than guessing its target.
    conflicted: session.conflicted || to < from || !transaction.doc.slice(from, to).content.eq(session.original),
  }
}

export function applyBlockSource(
  state: EditorState,
  session: BlockSourceSession,
  markdown: string,
  codec: BlockSourceCodec,
  options: { isolateHistory?: boolean } = {},
): { transaction: Transaction; session: BlockSourceSession } {
  if (session.conflicted || session.to > state.doc.content.size || !state.doc.slice(session.from, session.to).content.eq(session.original)) {
    throw new Error('此块已被其他编辑更新，源码草稿仍保留。请先复制草稿，再取消并重新打开此块。')
  }
  if (markdown === session.markdown) {
    const transaction = state.tr
    if (options.isolateHistory !== false) closeHistory(transaction)
    return { transaction, session }
  }
  const parsed = codec.parse(markdown)
  if (parsed.type !== state.schema.topNodeType.name) throw new Error('无法将此 Markdown 解析为文档内容。')
  const replacement = state.schema.nodeFromJSON({
    ...parsed,
    content: parsed.content?.length ? parsed.content : [{ type: 'paragraph' }],
  })
  replacement.check()
  const transaction = replacement.content.eq(session.original)
    ? state.tr
    : state.tr.replaceWith(session.from, session.to, replacement.content)
  transaction.setSelection(Selection.near(transaction.doc.resolve(session.from + 1)))
  if (options.isolateHistory !== false) closeHistory(transaction)
  const singleNode = replacement.childCount === 1 ? replacement.firstChild : null
  return {
    transaction,
    session: {
      ...session,
      to: session.from + replacement.content.size,
      nodeType: singleNode?.type.name ?? 'doc',
      label: singleNode ? blockLabels[singleNode.type.name] ?? singleNode.type.name : '多个段落',
      original: replacement.content,
      markdown,
      initialSelection: { from: markdown.length, to: markdown.length },
      conflicted: false,
    },
  }
}

function serializeFragment(fragment: Fragment, codec: BlockSourceCodec) {
  return codec.serialize({ type: 'doc', content: fragment.toJSON() })
}

function sourceOffset(node: ProseMirrorNode, markdown: string, position: number, codec: BlockSourceCodec) {
  if (!node.isTextblock || !['paragraph', 'heading'].includes(node.type.name)) return markdown.length
  const offset = Math.max(0, Math.min(position, node.content.size))
  if (offset === 0 && node.type.name === 'heading') return /^#{1,6}\s/.exec(markdown)?.[0].length ?? 0
  const prefix = serializeFragment(Fragment.from(node.copy(node.content.cut(0, offset))), codec)
  let common = 0
  // Serializing a prefix closes its marks. The common prefix ends before those synthetic closing markers.
  while (common < prefix.length && common < markdown.length && prefix[common] === markdown[common]) common += 1
  return common
}
