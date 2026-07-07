import { describe, it, expect } from 'vitest'
import { isSafeMarkdownHref } from '../../../src/renderer/features/chat/safeMarkdownLink'

describe('isSafeMarkdownHref', () => {
  it('允许 https 链接', () => {
    expect(isSafeMarkdownHref('https://example.com')).toBe(true)
  })

  it('拒绝 javascript: scheme', () => {
    expect(isSafeMarkdownHref('javascript:alert(1)')).toBe(false)
  })

  it('拒绝 file: scheme', () => {
    expect(isSafeMarkdownHref('file:///C:/Windows/win.ini')).toBe(false)
  })

  it('拒绝 data: scheme', () => {
    expect(isSafeMarkdownHref('data:text/html,<script>alert(1)</script>')).toBe(false)
  })
})
