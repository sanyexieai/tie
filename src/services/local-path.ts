/**
 * Convert a file:// URL to a local filesystem path.
 * Supports Windows drive letters, UNC shares, and POSIX paths.
 */
export function fileUrlToLocalPath(href: string): string | null {
  const raw = String(href || '').trim()
  if (!/^file:/i.test(raw)) return null

  try {
    const url = new URL(raw)
    let pathname = decodeURIComponent(url.pathname || '')

    // file://server/share/dir → \\server\share\dir
    if (url.hostname && !['localhost', '127.0.0.1'].includes(url.hostname.toLowerCase())) {
      const rest = pathname.replace(/\//g, '\\')
      return `\\\\${url.hostname}${rest}`
    }

    // file:///C:/Users/... or file:///C|/Users/...
    if (/^\/[A-Za-z]:/.test(pathname)) {
      return pathname.slice(1).replace(/\//g, '\\')
    }
    if (/^\/[A-Za-z]\|/.test(pathname)) {
      return pathname.slice(1).replace('|', ':').replace(/\//g, '\\')
    }

    return pathname || null
  } catch {
    // Some editors write file:///C:\Users\... with backslashes
    const match = raw.match(/^file:\/{2,3}(.+)$/i)
    if (!match?.[1]) return null
    let path = decodeURIComponent(match[1].replace(/^\/+/, ''))
    if (/^[A-Za-z]:/.test(path) || path.startsWith('\\\\')) {
      return path.replace(/\//g, '\\')
    }
    return path.startsWith('/') ? path : `/${path}`
  }
}

export function isLocalFileHref(href: string) {
  return Boolean(fileUrlToLocalPath(href))
}
