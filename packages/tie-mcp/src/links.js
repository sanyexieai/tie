const FILE_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export function isStorageSourceId(value) {
  const id = String(value || '').trim()
  if (!id) return false
  if (id === 'source-demo-local') return true
  if (/^src_(local|smb)_[0-9a-f]{16}$/i.test(id)) return true
  if (id.startsWith('s3:') && id.length > 3) return true
  if (id.startsWith('backend:') || id.startsWith('backend-s3:')) return true
  return false
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function splitHrefSegments(raw) {
  return raw.split('/').filter(Boolean).map(decodeSegment)
}

function restAfterPrefix(href, prefix) {
  return href.slice(prefix.length).split(/[?#]/)[0] ?? ''
}

export function parseFileUrl(href) {
  if (!href.startsWith('tie://file/')) return null
  const parts = splitHrefSegments(restAfterPrefix(href, 'tie://file/'))
  if (parts.length >= 2 && isStorageSourceId(parts[0])) {
    const fileId = parts[1]
    if (!fileId || !FILE_ID_PATTERN.test(fileId)) return null
    return { sourceId: parts[0], fileId }
  }
  if (parts.length === 1 && FILE_ID_PATTERN.test(parts[0])) {
    return { fileId: parts[0] }
  }
  return null
}

export function parsePathUrl(href) {
  if (!href.startsWith('tie://path/')) return null
  const parts = splitHrefSegments(restAfterPrefix(href, 'tie://path/'))
  if (!parts.length) return null
  if (parts.length >= 2 && isStorageSourceId(parts[0])) {
    return { sourceId: parts[0], relativePath: parts.slice(1).join('/') }
  }
  return { relativePath: parts.join('/') }
}

export function buildFileUrl(fileId, sourceId) {
  const id = String(fileId || '').trim()
  const source = String(sourceId || '').trim()
  if (source) return `tie://file/${encodeURIComponent(source)}/${encodeURIComponent(id)}`
  return `tie://file/${id}`
}

export function buildPathUrl(relativePath, sourceId) {
  const encoded = String(relativePath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/')
  const source = String(sourceId || '').trim()
  if (source) return `tie://path/${encodeURIComponent(source)}/${encoded}`
  return `tie://path/${encoded}`
}

const TIE_FILE_OR_PATH_HREF = /tie:\/\/(?:file|path)\/[^\s)\]>'"]+/g

export function rewriteLegacyWorkspaceHrefs(markdown, pageSourceId) {
  const source = String(pageSourceId || '').trim()
  const text = String(markdown || '')
  if (!source || !isStorageSourceId(source)) return text
  return text.replace(TIE_FILE_OR_PATH_HREF, (href) => {
    const file = parseFileUrl(href)
    if (file) {
      if (file.sourceId) return href
      return buildFileUrl(file.fileId, source)
    }
    const relative = parsePathUrl(href)
    if (relative) {
      if (relative.sourceId) return href
      return buildPathUrl(relative.relativePath, source)
    }
    return href
  })
}

export function assetRelativePath(pageId, assetName) {
  return `.tie/assets/${pageId}/${assetName}`
}
