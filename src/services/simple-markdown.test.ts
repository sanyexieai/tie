import { describe, expect, it } from 'vitest'
import { simpleMarkdownToHtml } from '@/services/simple-markdown'

describe('read-only Markdown links', () => {
  it.each([
    'javascript:window.__unsafe=1',
    'JaVaScRiPt:window.__unsafe=1',
    'java\tscript:window.__unsafe=1',
    'data:text/html,<script>unsafe</script>',
    'vbscript:unsafe',
  ])('renders unsafe protocol %s as text', (href) => {
    expect(simpleMarkdownToHtml(`[链接](${href})`)).toBe('<p>链接</p>')
  })

  it.each([
    'https://example.com/page',
    'http://localhost:8787/',
    'mailto:someone@example.com',
    'tel:123456',
    'tie://page/pg_test',
    './relative-page',
    '#section',
  ])('keeps supported link %s', (href) => {
    expect(simpleMarkdownToHtml(`[链接](${href})`)).toContain(`<a href="${href}"`)
  })

  it('escapes HTML in link labels and URLs', () => {
    const html = simpleMarkdownToHtml('[<img src=x>](https://example.com/"quoted")')
    expect(html).toContain('&lt;img src=x&gt;')
    expect(html).toContain('https://example.com/&quot;quoted&quot;')
    expect(html).not.toContain('<img')
  })
})
