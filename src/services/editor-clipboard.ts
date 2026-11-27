import type { Editor } from '@tiptap/core'

async function writeClipboardContent(html: string, text: string) {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Rich clipboard unavailable')
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })])
  } catch (error) {
    if ('__TAURI_INTERNALS__' in window) {
      const { writeHtml } = await import('@tauri-apps/plugin-clipboard-manager')
      await writeHtml(html, text)
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else throw error
  }
}

export async function copyEditorSelection(editor: Editor) {
  const { dom, text } = editor.view.serializeForClipboard(editor.state.selection.content())
  await writeClipboardContent(dom.innerHTML, text)
}

export async function copyEditorText(text: string) {
  const element = document.createElement('span')
  element.textContent = text
  await writeClipboardContent(element.outerHTML, text)
}

export async function pasteEditorClipboard(editor: Editor, canApply: () => boolean) {
  const data = new DataTransfer()
  try {
    if (!navigator.clipboard?.read) throw new Error('Clipboard read unavailable')
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) {
        const blob = await item.getType(type)
        if (type === 'text/html' || type === 'text/plain') data.setData(type, await blob.text())
        else if (type.startsWith('image/')) data.items.add(new File([blob], 'clipboard-image', { type }))
      }
    }
  } catch (error) {
    if ('__TAURI_INTERNALS__' in window) {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
      data.setData('text/plain', await readText())
    } else if (navigator.clipboard?.readText) {
      data.setData('text/plain', await navigator.clipboard.readText())
    } else throw error
  }
  if (!canApply()) return
  // Dispatch the same paste pipeline as Ctrl+V, including protected images and local-file rewriting.
  editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
}
