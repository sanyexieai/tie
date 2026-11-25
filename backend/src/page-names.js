const RESERVED_STEMS = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/** UTF-8 被当成 Latin-1 存下来时（测试 → æµè¯），还原成原文。已经含有真正中文的字符串不动。 */
export function repairUtf8Mojibake(text) {
  const value = String(text ?? '')
  const chars = [...value]
  if (!chars.some((ch) => ch.charCodeAt(0) >= 0x80 && ch.charCodeAt(0) <= 0xff)) return value
  if (chars.some((ch) => ch.codePointAt(0) > 0xff)) return value
  const bytes = Uint8Array.from(chars, (ch) => ch.charCodeAt(0))
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (decoded !== value && /\p{Script=Han}/u.test(decoded)) return decoded
  } catch {
    return value
  }
  return value
}

/** 标题变成单个路径片段。空的或 Windows 保留名用 fallback。和本地 tie-local 的 filename_stem 一致。 */
export function filenameStem(raw, fallback = '无标题') {
  const source = repairUtf8Mojibake(raw)
  let stem = ''
  let spaced = false
  for (const ch of source) {
    const illegal = '\\/:*?"<>|'.includes(ch) || ch.charCodeAt(0) < 0x20
    if (illegal || /\s/u.test(ch)) {
      if (!spaced && stem) {
        stem += ' '
        spaced = true
      }
      continue
    }
    stem += ch
    spaced = false
  }
  stem = stem.trim().replace(/^\.+|\.+$/g, '').trim()
  stem = [...stem].slice(0, 80).join('').trim().replace(/^\.+|\.+$/g, '').trim()
  if (!stem || RESERVED_STEMS.has(stem.toUpperCase())) {
    const next = String(fallback ?? '').trim()
    return next ? [...next].slice(0, 80).join('') : '无标题'
  }
  return stem
}
