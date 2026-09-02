const STORAGE_KEY = 'tie.app-update.endpoints'

export const DEFAULT_UPDATE_ENDPOINTS = [
  'https://github.com/sanyexieai/tie/releases/latest/download/latest.json',
] as const

function normalizeEndpoint(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.toString()
  } catch {
    return null
  }
}

export function loadUpdateEndpoints(): string[] {
  if (typeof localStorage === 'undefined') return [...DEFAULT_UPDATE_ENDPOINTS]
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return [...DEFAULT_UPDATE_ENDPOINTS]
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return [...DEFAULT_UPDATE_ENDPOINTS]
    const endpoints = parsed
      .filter((item): item is string => typeof item === 'string')
      .map(normalizeEndpoint)
      .filter((item): item is string => item !== null)
    return endpoints.length ? endpoints : [...DEFAULT_UPDATE_ENDPOINTS]
  } catch {
    return [...DEFAULT_UPDATE_ENDPOINTS]
  }
}

export function saveUpdateEndpoints(endpoints: string[]): void {
  if (typeof localStorage === 'undefined') return
  const normalized = endpoints
    .map(normalizeEndpoint)
    .filter((item): item is string => item !== null)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
}

export function resetUpdateEndpoints(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(STORAGE_KEY)
}

export function hasCustomUpdateEndpoints(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(STORAGE_KEY) !== null
}

export function parseUpdateEndpointInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map(normalizeEndpoint)
    .filter((item): item is string => item !== null)
}
