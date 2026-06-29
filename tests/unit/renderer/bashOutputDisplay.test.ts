import { describe, expect, it } from 'vitest'
import {
  LIVE_SHELL_OUTPUT_MAX_CHARS,
  clampBashShellOutputForDisplay
} from '../../../src/renderer/features/chat/bashOutputDisplay'

describe('bashOutputDisplay', () => {
  it('未超限时应原样返回', () => {
    const text = 'line1\nline2\n'
    const slice = clampBashShellOutputForDisplay(text)
    expect(slice).toEqual({
      text,
      truncated: false,
      omittedChars: 0,
      totalChars: text.length
    })
  })

  it('超限时保留尾部字符', () => {
    const head = 'H'.repeat(15_000)
    const tail = 'T'.repeat(100)
    const full = head + tail
    const slice = clampBashShellOutputForDisplay(full, LIVE_SHELL_OUTPUT_MAX_CHARS)

    expect(slice.truncated).toBe(true)
    expect(slice.omittedChars).toBe(full.length - LIVE_SHELL_OUTPUT_MAX_CHARS)
    expect(slice.text.length).toBe(LIVE_SHELL_OUTPUT_MAX_CHARS)
    expect(slice.text.endsWith(tail)).toBe(true)
  })

  it('恰好等于上限不截断', () => {
    const text = 'x'.repeat(LIVE_SHELL_OUTPUT_MAX_CHARS)
    const slice = clampBashShellOutputForDisplay(text)
    expect(slice.truncated).toBe(false)
    expect(slice.text).toBe(text)
  })
})
