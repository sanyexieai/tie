export const ENCRYPTED_MARKDOWN_PREFIX = '-----BEGIN TIE ENCRYPTED MARKDOWN-----'
const SUFFIX = '-----END TIE ENCRYPTED MARKDOWN-----'
const ITERATIONS = 600_000
const encoder = new TextEncoder()
const additionalData = encoder.encode('tie:encrypted-markdown:v1')
const workspaceKeys = new Map<string, CryptoKey>()

interface Envelope {
  version: 1
  algorithm: 'AES-256-GCM'
  kdf: 'PBKDF2-SHA256'
  iterations: number
  salt: string
  iv: string
  ciphertext: string
}

/** A damaged encrypted file must still open as a locked document. */
export function isEncryptedMarkdown(text: string) {
  return text.replace(/^\uFEFF/, '').startsWith(ENCRYPTED_MARKDOWN_PREFIX)
}

export async function importEncryptionPassword(password: string): Promise<CryptoKey> {
  if (!password.length) throw new Error('请输入加密密码')
  return subtle().importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
}

export async function encryptMarkdown(markdown: string, passwordKey: CryptoKey): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passwordKey, salt)
  const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, encoder.encode(markdown))
  const envelope: Envelope = { version: 1, algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: ITERATIONS,
    salt: encodeBase64(salt), iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)) }
  return `${ENCRYPTED_MARKDOWN_PREFIX}\n${JSON.stringify(envelope)}\n${SUFFIX}\n`
}

export async function decryptMarkdown(text: string, passwordKey: CryptoKey): Promise<string> {
  const { salt, iv, ciphertext } = parseEnvelope(text)
  const key = await deriveKey(passwordKey, salt)
  try {
    const plaintext = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, ciphertext)
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  } catch {
    throw new Error('无法解密文档，请检查密码或文件是否完整')
  }
}

export function getWorkspaceEncryptionKey(sourceId: string) { return workspaceKeys.get(sourceId) }
export function setWorkspaceEncryptionKey(sourceId: string, key: CryptoKey) { workspaceKeys.set(sourceId, key) }
export function lockWorkspaceEncryption(sourceId: string) { workspaceKeys.delete(sourceId) }
export function lockAllWorkspaceEncryption() { workspaceKeys.clear() }

function subtle() {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持文档加密，请在 Tie 客户端或 HTTPS 网页中使用')
  return globalThis.crypto.subtle
}

function deriveKey(passwordKey: CryptoKey, salt: Uint8Array<ArrayBuffer>) {
  return subtle().deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, passwordKey,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

function parseEnvelope(text: string) {
  try {
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    const lines = normalized.trimEnd().split('\n')
    if (lines.length !== 3 || lines[0] !== ENCRYPTED_MARKDOWN_PREFIX || lines[2] !== SUFFIX) throw new Error()
    const value: unknown = JSON.parse(lines[1]!)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    const data = value as Envelope
    if (data.version !== 1 || data.algorithm !== 'AES-256-GCM' || data.kdf !== 'PBKDF2-SHA256'
      || data.iterations !== ITERATIONS) throw new Error()
    const salt = decodeBase64(data.salt)
    const iv = decodeBase64(data.iv)
    const ciphertext = decodeBase64(data.ciphertext)
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) throw new Error()
    return { salt, iv, ciphertext }
  } catch {
    throw new Error('加密文档格式无效或版本不受支持')
  }
}

function encodeBase64(bytes: Uint8Array<ArrayBuffer>) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  }
  return btoa(binary)
}

function decodeBase64(value: string) {
  if (typeof value !== 'string' || !value.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error()
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}
