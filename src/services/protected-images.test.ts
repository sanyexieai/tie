import { describe, expect, it } from 'vitest'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { MarkdownManager } from '@tiptap/markdown'
import { decryptMarkdown, encryptMarkdown, importEncryptionPassword } from '@/services/encrypted-markdown'
import { isProtectedImageDataUrl, MAX_PROTECTED_IMAGE_BYTES, protectedImageDataUrl } from './protected-images'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const pngBytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0))

describe('images inside protected Markdown', () => {
  it('embeds a real raster image without an asset or file registry reference', async () => {
    const src = await protectedImageDataUrl(new Blob([pngBytes], { type: 'image/png' }))
    expect(src).toBe(`data:image/png;base64,${png}`)
    expect(isProtectedImageDataUrl(src)).toBe(true)
    expect(src).not.toContain('tie://asset/')
    expect(src).not.toContain('tie://file/')
    const markdown = new MarkdownManager({ extensions: [StarterKit, Image.configure({ allowBase64: true, inline: true })] })
    const first = markdown.parse(`![部署截图](${src})`)
    const serialized = markdown.serialize(first)
    expect(serialized).toContain(src)
    expect(markdown.parse(serialized)).toEqual(first)
    const key = await importEncryptionPassword('protected-image-test-password')
    const ciphertext = await encryptMarkdown(serialized, key)
    expect(ciphertext).not.toContain(png)
    expect(await decryptMarkdown(ciphertext, key)).toBe(serialized)
  })

  it('uses the image bytes rather than trusting a declared MIME type', async () => {
    expect(await protectedImageDataUrl(new Blob([pngBytes], { type: 'image/svg+xml' }))).toMatch(/^data:image\/png;base64,/)
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" />'
    await expect(protectedImageDataUrl(new Blob([svg], { type: 'image/png' }))).rejects.toThrow('加密页面支持')
    expect(isProtectedImageDataUrl(`data:image/png;base64,${btoa(svg)}`)).toBe(false)
    expect(isProtectedImageDataUrl(`data:image/svg+xml;base64,${btoa(svg)}`)).toBe(false)
  })

  it('rejects network, blob, active content, invalid Base64 and oversized input', async () => {
    for (const src of ['https://example.test/private.png', 'blob:private', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,%%%']) {
      expect(isProtectedImageDataUrl(src)).toBe(false)
    }
    await expect(protectedImageDataUrl(new Blob([new Uint8Array(MAX_PROTECTED_IMAGE_BYTES + 1)]))).rejects.toThrow('图片超过 20 MB')
  })
})
