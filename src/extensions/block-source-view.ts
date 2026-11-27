import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { BlockSourceSession } from '@/services/block-source'

export interface BlockSourceViewOptions {
  getSession: () => BlockSourceSession | null
  getKey: () => string
  mount: (host: HTMLElement) => void
  unmount: (host: HTMLElement) => void
}

export const blockSourceViewKey = new PluginKey('tieBlockSourceView')

export function createBlockSourceViewPlugin(options: BlockSourceViewOptions) {
  let mountedHost: HTMLElement | null = null
  const destroyedHosts = new WeakSet<Node>()
  return new Plugin({
    key: blockSourceViewKey,
    props: {
      decorations(state) {
        const session = options.getSession()
        if (!session) return DecorationSet.empty
        const key = options.getKey()
        const position = Math.max(0, Math.min(session.from, state.doc.content.size))
        const decorations: Decoration[] = [Decoration.widget(position, () => {
          const host = document.createElement('div')
          host.className = 'block-source-host'
          host.contentEditable = 'false'
          host.setAttribute('data-block-source-host', '')
          // Vue Teleport may update synchronously; notify it after ProseMirror has attached this widget.
          queueMicrotask(() => {
            if (destroyedHosts.has(host) || !host.isConnected || options.getKey() !== key || !options.getSession()) return
            mountedHost = host
            options.mount(host)
          })
          return host
        }, {
          key,
          side: -1,
          stopEvent: () => true,
          ignoreSelection: true,
          destroy(node) {
            destroyedHosts.add(node)
            if (mountedHost !== node) return
            mountedHost = null
            options.unmount(node as HTMLElement)
          },
        })]
        state.doc.forEach((node, from) => {
          const to = from + node.nodeSize
          if (from >= session.from && to <= session.to) {
            decorations.push(Decoration.node(from, to, {
              style: 'display: none;',
              'data-block-source-hidden': 'true',
            }))
          }
        })
        return DecorationSet.create(state.doc, decorations)
      },
    },
  })
}

export function createBlockSourceView(options: BlockSourceViewOptions) {
  return Extension.create({
    name: 'blockSourceView',
    addProseMirrorPlugins() {
      return [createBlockSourceViewPlugin(options)]
    },
  })
}
