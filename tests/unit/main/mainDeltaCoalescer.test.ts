import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  pushMainTextDelta,
  pushMainThinkingDelta,
  flushMainDeltaCoalescer,
  resetMainDeltaCoalescerForTests
} from '../../../src/main/ipc/mainDeltaCoalescer'

function makeWindow() {
  const send = vi.fn()
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send
    },
    _send: send
  }
}

describe('mainDeltaCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetMainDeltaCoalescerForTests()
  })

  afterEach(() => {
    resetMainDeltaCoalescerForTests()
    vi.useRealTimers()
  })

  it('16ms 内合并同 messageId 的 text delta', () => {
    const win = makeWindow()
    pushMainTextDelta(win as never, 'm1', 'hello ')
    pushMainTextDelta(win as never, 'm1', 'world')

    expect(win._send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(16)

    expect(win._send).toHaveBeenCalledTimes(1)
    expect(win._send).toHaveBeenCalledWith('agent:text-delta', {
      messageId: 'm1',
      delta: 'hello world'
    })
  })

  it('按 messageId 分桶，不同消息不串台', () => {
    const win = makeWindow()
    pushMainTextDelta(win as never, 'm1', 'a')
    pushMainTextDelta(win as never, 'm2', 'b')
    vi.advanceTimersByTime(16)

    expect(win._send).toHaveBeenCalledTimes(2)
    expect(win._send).toHaveBeenCalledWith('agent:text-delta', { messageId: 'm1', delta: 'a' })
    expect(win._send).toHaveBeenCalledWith('agent:text-delta', { messageId: 'm2', delta: 'b' })
  })

  it('thinking 与 text 分开发送', () => {
    const win = makeWindow()
    pushMainThinkingDelta(win as never, 'm1', 'think')
    pushMainTextDelta(win as never, 'm1', 'say')
    vi.advanceTimersByTime(16)

    expect(win._send).toHaveBeenCalledTimes(2)
    expect(win._send).toHaveBeenCalledWith('agent:thinking-delta', { messageId: 'm1', delta: 'think' })
    expect(win._send).toHaveBeenCalledWith('agent:text-delta', { messageId: 'm1', delta: 'say' })
  })

  it('flushNow 在定时器到期前立即发送', () => {
    const win = makeWindow()
    pushMainTextDelta(win as never, 'm1', 'pending')
    flushMainDeltaCoalescer(win as never)

    expect(win._send).toHaveBeenCalledWith('agent:text-delta', { messageId: 'm1', delta: 'pending' })

    vi.advanceTimersByTime(32)
    expect(win._send).toHaveBeenCalledTimes(1)
  })

  it('窗口已销毁时 flush 清空缓冲且不 send', () => {
    const win = {
      isDestroyed: () => true,
      webContents: { isDestroyed: () => false, send: vi.fn() }
    }
    pushMainTextDelta(win as never, 'm1', 'x')
    flushMainDeltaCoalescer(win as never)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})
