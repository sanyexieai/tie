import { afterEach, describe, expect, it } from 'vitest'
import {
  decryptMarkdown, encryptMarkdown, ENCRYPTED_MARKDOWN_PREFIX, getWorkspaceEncryptionKey,
  importEncryptionPassword, isEncryptedMarkdown, lockAllWorkspaceEncryption, lockWorkspaceEncryption,
  setWorkspaceEncryptionKey,
} from './encrypted-markdown'

afterEach(lockAllWorkspaceEncryption)

describe('encrypted Markdown using real Web Crypto', () => {
  it('round-trips Unicode Markdown and an empty document without serializing a password or plaintext', async () => {
    const password = 'fixture-only-encryption-passphrase-92841'
    const key = await importEncryptionPassword(password)
    expect(key.extractable).toBe(false)
    const markdown = '# 私有配置\n\n- token: `fixture-secret-28518`\n\n| 服务 | 环境 |\n| --- | --- |\n| Tie | local |\n'
    const encrypted = await encryptMarkdown(markdown, key)
    expect(isEncryptedMarkdown(encrypted)).toBe(true)
    expect(encrypted).not.toContain(password)
    expect(encrypted).not.toContain('fixture-secret-28518')
    expect(encrypted).not.toContain('私有配置')
    expect(await decryptMarkdown(encrypted, key)).toBe(markdown)
    expect(await decryptMarkdown(await encryptMarkdown('', key), key)).toBe('')
    await expect(importEncryptionPassword('')).rejects.toThrow('请输入加密密码')
  })

  it('uses independent salts and IVs for each save, including the same plaintext and password', async () => {
    const key = await importEncryptionPassword('fixture-passphrase')
    const first = await encryptMarkdown('same text', key)
    const second = await encryptMarkdown('same text', key)
    expect(first).not.toBe(second)
    const a = JSON.parse(first.split('\n')[1]!)
    const b = JSON.parse(second.split('\n')[1]!)
    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(await decryptMarkdown(second, key)).toBe('same text')
  })

  it('rejects a wrong password and tampering without returning plaintext', async () => {
    const key = await importEncryptionPassword('correct-fixture-password')
    const encrypted = await encryptMarkdown('private text', key)
    const wrong = await importEncryptionPassword('wrong-fixture-password')
    await expect(decryptMarkdown(encrypted, wrong)).rejects.toThrow('无法解密文档，请检查密码或文件是否完整')
    const lines = encrypted.split('\n')
    const envelope = JSON.parse(lines[1]!)
    const ciphertext = Uint8Array.from(atob(envelope.ciphertext), (character) => character.charCodeAt(0))
    ciphertext[0] = ciphertext[0]! ^ 1
    envelope.ciphertext = btoa(String.fromCharCode(...ciphertext))
    lines[1] = JSON.stringify(envelope)
    await expect(decryptMarkdown(lines.join('\n'), key)).rejects.toThrow('无法解密文档，请检查密码或文件是否完整')
  })

  it('keeps damaged envelopes classified as encrypted and rejects unsupported work factors before derivation', async () => {
    const key = await importEncryptionPassword('fixture-passphrase')
    const encrypted = await encryptMarkdown('body', key)
    expect(isEncryptedMarkdown(`${ENCRYPTED_MARKDOWN_PREFIX}\nbroken`)).toBe(true)
    expect(isEncryptedMarkdown(`\uFEFF${ENCRYPTED_MARKDOWN_PREFIX}\nbroken`)).toBe(true)
    expect(isEncryptedMarkdown('# Ordinary Markdown')).toBe(false)
    for (const body of [
      `${ENCRYPTED_MARKDOWN_PREFIX}\nbroken`,
      encrypted.replace('"iterations":600000', '"iterations":4294967295'),
      encrypted.replace('"version":1', '"version":2'),
      encrypted.replace('"iv":"', '"iv":"!'),
      encrypted.replace('-----END TIE ENCRYPTED MARKDOWN-----', ''),
    ]) {
      await expect(decryptMarkdown(body, key)).rejects.toThrow('加密文档格式无效或版本不受支持')
    }
    expect(await decryptMarkdown(encrypted.replace(/\n/g, '\r\n'), key)).toBe('body')
    expect(await decryptMarkdown(`\uFEFF${encrypted}`, key)).toBe('body')
  })

  it('encodes large documents without an argument-spread size limit', async () => {
    const markdown = 'private line\n'.repeat(24_000)
    const key = await importEncryptionPassword('fixture-passphrase')
    const encrypted = await encryptMarkdown(markdown, key)
    expect(await decryptMarkdown(encrypted, key)).toBe(markdown)
  })

  it('isolates in-memory workspace keys and clears them on individual or complete lock', async () => {
    const key = await importEncryptionPassword('fixture-passphrase')
    setWorkspaceEncryptionKey('source-a', key)
    setWorkspaceEncryptionKey('source-b', key)
    expect(getWorkspaceEncryptionKey('source-a')).toBe(key)
    expect(getWorkspaceEncryptionKey('source-missing')).toBeUndefined()
    lockWorkspaceEncryption('source-a')
    expect(getWorkspaceEncryptionKey('source-a')).toBeUndefined()
    expect(getWorkspaceEncryptionKey('source-b')).toBe(key)
    lockAllWorkspaceEncryption()
    expect(getWorkspaceEncryptionKey('source-b')).toBeUndefined()
  })
})
