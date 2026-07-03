import { describe, it, expect } from 'vitest'
import {
  SESSION_PLACEHOLDER_TITLE,
  SESSION_MIGRATED_EMPTY_TITLE,
  clampSessionTitle,
  generateSessionTitleFromText
} from '../../../../src/shared/session/title'

describe('session title helpers', () => {
  it('占位文案常量对齐', () => {
    expect(SESSION_PLACEHOLDER_TITLE).toBe('新会话')
    expect(SESSION_MIGRATED_EMPTY_TITLE).toBe('历史会话')
  })

  it('generateSessionTitleFromText 按码点截断并加省略号', () => {
    const long = 'a'.repeat(35)
    expect(generateSessionTitleFromText(long)).toBe('a'.repeat(30) + '…')
  })

  it('emoji 不被 surrogate pair 切半', () => {
    const text = '😀'.repeat(31)
    const title = generateSessionTitleFromText(text)
    expect(Array.from(title.replace('…', ''))).toHaveLength(30)
    expect(title.endsWith('…')).toBe(true)
  })

  it('clampSessionTitle 手动改名截断不加省略号', () => {
    expect(clampSessionTitle('hello')).toBe('hello')
    expect(clampSessionTitle('x'.repeat(40))).toHaveLength(30)
  })
})
