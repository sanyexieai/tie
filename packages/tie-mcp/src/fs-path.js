import path from 'node:path'

/**
 * Strip Windows extended-length / verbatim prefixes (`\\?\`, `//?/`).
 * Safe to call on any platform.
 */
export function stripWindowsExtendedPrefix(input) {
  const text = String(input || '')
  if (text.startsWith('\\\\?\\UNC\\')) return `\\\\${text.slice('\\\\?\\UNC\\'.length)}`
  if (text.startsWith('\\\\?\\')) return text.slice('\\\\?\\'.length)
  if (text.startsWith('//?/UNC/')) return `\\\\${text.slice('//?/UNC/'.length).replace(/\//g, '\\')}`
  if (text.startsWith('//?/')) return text.slice('//?/'.length)
  return text
}

/** Resolve to an absolute path after stripping Windows extended prefixes. */
export function resolveFsPath(...parts) {
  const cleaned = parts.map((part) => stripWindowsExtendedPrefix(part))
  return path.resolve(...cleaned)
}

/**
 * Compare two paths as the same location (resolve + strip).
 * On win32, comparison is case-insensitive.
 */
export function pathsEqual(left, right) {
  const a = resolveFsPath(left)
  const b = resolveFsPath(right)
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase()
  }
  return a === b
}
