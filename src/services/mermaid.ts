let renderer: Promise<typeof import('mermaid')['default']> | undefined
let nextId = 0

export async function renderMermaid(source: string): Promise<string> {
  renderer ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true })
    return mermaid
  }).catch((error) => {
    renderer = undefined
    throw error
  })
  const mermaid = await renderer
  const { svg } = await mermaid.render(`tie-mermaid-${++nextId}`, source)
  return svg
}
