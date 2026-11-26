/** Canonical on-disk shape for `.tie/files/{id}/meta.json`. Extra fields are preserved. */

function text(value) {
  return String(value ?? '').trim()
}

function looksLikeContentUri(value) {
  return /^content:\/\//i.test(value)
}

function locatorFrom(raw, sourcePath, storedPath) {
  const existing = raw.locator && typeof raw.locator === 'object' ? raw.locator : null
  const androidUri = text(existing?.androidUri)
    || (looksLikeContentUri(sourcePath) ? sourcePath : '')
    || (looksLikeContentUri(storedPath) ? storedPath : '')
    || undefined
  const desktopPath = text(existing?.desktopPath)
    || (androidUri || looksLikeContentUri(sourcePath) ? '' : sourcePath)
  const displayPath = text(existing?.displayPath) || desktopPath || text(raw.title) || androidUri || storedPath
  const type = text(existing?.type) === 'android' || (Boolean(androidUri) && !desktopPath) ? 'android'
    : text(existing?.type) === 'display' ? 'display'
    : 'desktop'
  const locator = { type, displayPath }
  if (desktopPath) locator.desktopPath = desktopPath
  if (androidUri) locator.androidUri = androidUri
  return locator
}

export function normalizeDeviceBindings(raw) {
  const bindings = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bindings
  for (const [id, value] of Object.entries(raw)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !value || typeof value !== 'object') continue
    const sourcePath = text(value.sourcePath)
    if (text(value.deviceId) !== id || !sourcePath) continue
    bindings[id] = { deviceId: id, deviceName: text(value.deviceName), platform: text(value.platform), sourcePath,
      locator: locatorFrom({ locator: value.locator }, sourcePath, sourcePath), boundAt: text(value.boundAt) }
  }
  return bindings
}

export function mergeDeviceBindings(left, right) {
  const merged = normalizeDeviceBindings(left)
  for (const [id, binding] of Object.entries(normalizeDeviceBindings(right))) {
    const previous = merged[id]
    if (!previous || binding.boundAt > previous.boundAt
      || (binding.boundAt === previous.boundAt && JSON.stringify(binding) > JSON.stringify(previous))) merged[id] = binding
  }
  return merged
}

export function mergeFileMetadata(left, right) {
  const winner = text(left?.updatedAt) > text(right?.updatedAt) ? left : right
  return normalizeFileMeta({ ...winner, deviceBindings: mergeDeviceBindings(left?.deviceBindings, right?.deviceBindings) })
}

export function portableCopyRelativePath(storedPath) {
  const relative = text(storedPath).replace(/\\/g, '/')
  if (!relative || relative.startsWith('/') || /^[^/]*:/.test(relative) || relative.includes('\0')) return null
  const parts = relative.split('/').filter((part) => part && part !== '.')
  if (!parts.length || parts.includes('..')) return null
  return parts.join('/')
}

export function normalizeFileMeta(raw, options = {}) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const now = options.now || new Date().toISOString()
  const id = text(input.id)
  const mode = input.mode === 'copy' ? 'copy' : 'link'
  const kind = input.kind === 'directory' ? 'directory' : 'file'
  const locatorInput = input.locator && typeof input.locator === 'object' ? input.locator : null
  const sourcePath = text(input.sourcePath) || text(locatorInput?.desktopPath) || text(locatorInput?.androidUri)
  const storedPath = text(input.storedPath) || (mode === 'link' ? sourcePath : '')
  const sourceId = text(input.sourceId) || text(options.sourceId) || undefined
  const hash = text(input.contentHash) || text(input.sha256) || null
  const meta = {
    id,
    title: text(input.title) || id,
    kind,
    mode,
    mime: text(input.mime) || 'application/octet-stream',
    ext: text(input.ext),
    size: Number(input.size || 0) || 0,
    sourcePath,
    storedPath,
    locator: locatorFrom(input, sourcePath, storedPath),
    deviceBindings: normalizeDeviceBindings(input.deviceBindings),
    contentHash: hash,
    sha256: hash,
    createdAt: text(input.createdAt) || now,
    updatedAt: text(input.updatedAt) || now,
  }
  if (sourceId) meta.sourceId = sourceId
  if (mode === 'copy' && input.preview != null) meta.preview = typeof input.preview === 'string' ? input.preview : null
  if (input.entryCount != null) meta.entryCount = input.entryCount
  if (input.mtime != null) meta.mtime = text(input.mtime) || null
  return meta
}

export function fileMetaToJson(meta) {
  const json = {
    id: meta.id,
    title: meta.title,
    kind: meta.kind,
    mode: meta.mode,
    mime: meta.mime,
    ext: meta.ext,
    size: meta.size,
    sourcePath: meta.sourcePath,
    storedPath: meta.storedPath,
    locator: meta.locator,
    deviceBindings: normalizeDeviceBindings(meta.deviceBindings),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
  if (meta.sourceId) json.sourceId = meta.sourceId
  if (meta.contentHash) json.contentHash = meta.contentHash
  if (meta.sha256) json.sha256 = meta.sha256
  if (meta.mode === 'copy' && meta.preview != null) json.preview = meta.preview
  if (meta.entryCount != null) json.entryCount = meta.entryCount
  if (meta.mtime != null) json.mtime = meta.mtime
  return json
}

export function indexEntryFromMeta(meta) {
  return {
    id: meta.id,
    title: meta.title,
    kind: meta.kind === 'directory' ? 'directory' : 'file',
    mode: meta.mode,
    ext: meta.ext,
    mime: meta.mime,
    size: meta.size,
    updatedAt: meta.updatedAt,
  }
}

export function resourceFromMeta(meta, options = {}) {
  if (!meta || typeof meta !== 'object') return null
  const normalized = normalizeFileMeta(meta, options)
  if (!normalized.id) return null
  const binding = normalized.deviceBindings[options.deviceId]
  const bindingState = normalized.mode === 'copy' ? 'portable' : binding ? 'bound'
    : Object.keys(normalized.deviceBindings).length ? 'other-device' : 'unbound'
  const portableCopy = normalized.mode === 'copy' && portableCopyRelativePath(normalized.storedPath)
  const openPath = normalized.mode === 'copy'
    ? portableCopy || ''
    : binding?.sourcePath || ''
  return {
    id: normalized.id,
    title: normalized.title,
    kind: normalized.kind,
    mode: normalized.mode,
    ext: normalized.ext,
    mime: normalized.mime,
    size: normalized.size,
    sourcePath: portableCopy ? normalized.sourcePath : '',
    storedPath: portableCopy || '',
    openPath,
    exists: (Boolean(portableCopy) || bindingState === 'bound') && Boolean(options.exists),
    updatedAt: normalized.updatedAt,
    sourceId: normalized.sourceId || null,
    locator: normalized.mode === 'copy' ? normalized.locator : { type: 'display', displayPath: normalized.title },
    createdAt: normalized.createdAt,
    deviceBindings: normalized.deviceBindings,
    bindingState,
    currentDeviceId: options.deviceId || null,
  }
}
