export const MAX_PROTECTED_IMAGE_BYTES = 20 * 1024 * 1024

/** Keep image bytes inside the Markdown that the document's protection layer encrypts. */
export async function protectedImageDataUrl(image: Blob): Promise<string> {
  if (image.size > MAX_PROTECTED_IMAGE_BYTES) throw new Error('图片超过 20 MB，请压缩后重试')
  const bytes = new Uint8Array(await image.arrayBuffer())
  const mime = rasterImageMime(bytes)
  if (!mime) throw new Error('加密页面支持 PNG、JPEG、GIF、WebP、BMP 和 ICO 图片')
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

export function isProtectedImageDataUrl(src: string): boolean {
  const match = /^data:(image\/(?:png|jpeg|gif|webp|bmp|x-icon));base64,([A-Za-z0-9+/]+={0,2})$/.exec(src)
  if (!match || match[2].length % 4 !== 0) return false
  const padding = match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0
  if (match[2].length / 4 * 3 - padding > MAX_PROTECTED_IMAGE_BYTES) return false
  try {
    const header = Uint8Array.from(atob(match[2].slice(0, 24)), (character) => character.charCodeAt(0))
    return rasterImageMime(header) === match[1]
  } catch { return false }
}

function rasterImageMime(bytes: Uint8Array) {
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  const signature = String.fromCharCode(...bytes.subarray(0, 12))
  if (signature.startsWith('GIF87a') || signature.startsWith('GIF89a')) return 'image/gif'
  if (signature.startsWith('RIFF') && signature.slice(8) === 'WEBP') return 'image/webp'
  if (signature.startsWith('BM')) return 'image/bmp'
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/x-icon'
  return null
}
