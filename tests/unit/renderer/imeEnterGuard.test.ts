/**
 * 输入法 Enter 守卫：开发输入框、学习输入框与停靠答题框共用，选词确认不能被当成发送。
 */
import { describe, expect, it, vi } from 'vitest'
import { createImeEnterGuard, IME_TRAILING_ENTER_WINDOW_MS } from '../../../src/renderer/features/chat/imeEnterGuard'

function keyDown(key: string, native: { isComposing?: boolean; keyCode?: number } = {}) {
  return { key, nativeEvent: native, preventDefault: vi.fn() }
}

function setup() {
  let clock = 1000
  const guard = createImeEnterGuard(() => clock)
  return { guard, advance: (ms: number) => { clock += ms } }
}

describe('createImeEnterGuard', () => {
  it('组合进行中的按键原样交给输入法，不阻止默认行为', () => {
    const { guard } = setup()
    const composing = keyDown('Enter', { isComposing: true })
    const legacy = keyDown('Enter', { keyCode: 229 })
    expect(guard.interceptKeyDown(composing)).toBe(true)
    expect(guard.interceptKeyDown(legacy)).toBe(true)
    expect(composing.preventDefault).not.toHaveBeenCalled()
    expect(legacy.preventDefault).not.toHaveBeenCalled()
  })

  it('组合刚结束的伴生 Enter 被拦截且不换行，下一次 Enter 正常放行', () => {
    const { guard, advance } = setup()
    guard.handleCompositionEnd()
    advance(10)
    const trailing = keyDown('Enter')
    expect(guard.interceptKeyDown(trailing)).toBe(true)
    expect(trailing.preventDefault).toHaveBeenCalledOnce()

    const next = keyDown('Enter')
    expect(guard.interceptKeyDown(next)).toBe(false)
    expect(next.preventDefault).not.toHaveBeenCalled()
  })

  it('用空格选词后松开再按 Enter，视为用户的发送', () => {
    const { guard, advance } = setup()
    guard.handleCompositionEnd()
    guard.handleKeyUp()
    advance(50)
    expect(guard.interceptKeyDown(keyDown('Enter'))).toBe(false)
  })

  it('超过时间窗的 Enter 不再拦截', () => {
    const { guard, advance } = setup()
    guard.handleCompositionEnd()
    advance(IME_TRAILING_ENTER_WINDOW_MS)
    expect(guard.interceptKeyDown(keyDown('Enter'))).toBe(false)
  })

  it('组合结束后先输入普通字符，时间窗即被消耗，字符与后续 Enter 都不受限', () => {
    const { guard, advance } = setup()
    guard.handleCompositionEnd()
    const char = keyDown('a')
    expect(guard.interceptKeyDown(char)).toBe(false)
    expect(char.preventDefault).not.toHaveBeenCalled()
    advance(10)
    expect(guard.interceptKeyDown(keyDown('Enter'))).toBe(false)
  })
})
