import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createStreamDeltaBuffer } from '../../../src/renderer/lib/streamDeltaBuffer'
import type { StreamDeltaBatch } from '../../../src/renderer/stores/useChatStore'

describe('streamDeltaBuffer', () => {
  let now = 0
  let pendingTimers: Array<{ at: number; cb: () => void }> = []
  const realSetTimeout = setTimeout
  const realClearTimeout = clearTimeout

  beforeEach(() => {
    now = 0
    pendingTimers = []
    // 用虚拟时间驱动，避免真实 setTimeout 抖动
    vi.useFakeTimers()
    vi.spyOn(global, 'setTimeout').mockImplementation((cb: () => void, ms: number) => {
      const handle = pendingTimers.length + 1
      pendingTimers.push({ at: now + (ms ?? 0), cb: cb as () => void })
      return handle as unknown as ReturnType<typeof setTimeout>
    })
    vi.spyOn(global, 'clearTimeout').mockImplementation((handle: number) => {
      pendingTimers = pendingTimers.filter((_, i) => i + 1 !== handle)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    realSetTimeout(() => undefined, 0)
    realClearTimeout(0)
  })

  function advanceTime(ms: number): void {
    now += ms
    const due = pendingTimers.filter(t => t.at <= now)
    pendingTimers = pendingTimers.filter(t => t.at > now)
    for (const t of due) t.cb()
  }

  it('pushText 多次调用应在 TEXT_FLUSH_MS 之后聚合为一次 flush', () => {
    const onFlush = vi.fn<(batch: StreamDeltaBatch) => void>()
    const buffer = createStreamDeltaBuffer(onFlush)

    buffer.pushText('msg_1', '你')
    buffer.pushText('msg_1', '好')
    buffer.pushText('msg_1', '世界')

    // 16ms 之前不应 flush
    advanceTime(15)
    expect(onFlush).not.toHaveBeenCalled()

    // 到达 16ms：触发一次 flush
    advanceTime(1)
    expect(onFlush).toHaveBeenCalledTimes(1)
    const batch = onFlush.mock.calls[0][0]
    expect(batch).toHaveLength(3)
    expect(batch[0]).toEqual({ kind: 'text', messageId: 'msg_1', delta: '你' })
    expect(batch[2]).toEqual({ kind: 'text', messageId: 'msg_1', delta: '世界' })

    buffer.dispose()
  })

  it('pushToolCallDelta 应在 300ms 后 flush', () => {
    const onFlush = vi.fn<(batch: StreamDeltaBatch) => void>()
    const buffer = createStreamDeltaBuffer(onFlush)

    buffer.pushToolCallDelta('msg_1', 'tc_1', '{"path":')
    buffer.pushToolCallDelta('msg_1', 'tc_1', '"foo.ts"}')

    advanceTime(299)
    expect(onFlush).not.toHaveBeenCalled()

    advanceTime(1)
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0][0]).toEqual([
      { kind: 'toolCall', messageId: 'msg_1', toolCallId: 'tc_1', delta: '{"path":' },
      { kind: 'toolCall', messageId: 'msg_1', toolCallId: 'tc_1', delta: '"foo.ts"}' }
    ])

    buffer.dispose()
  })

  it('flushNow 立即刷出所有待发 delta', () => {
    const onFlush = vi.fn<(batch: StreamDeltaBatch) => void>()
    const buffer = createStreamDeltaBuffer(onFlush)

    buffer.pushText('msg_1', 'a')
    buffer.pushThinking('msg_1', 'b')
    buffer.pushToolCallDelta('msg_1', 'tc_1', 'c')

    // 还未到任何 timer，立即 flush
    buffer.flushNow()

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0][0]).toHaveLength(3)
    // flushNow 后再推进时间不应再触发 flush
    advanceTime(1000)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('thinking 与 text 走同一 16ms timer，混合 push 后只 flush 一次', () => {
    const onFlush = vi.fn<(batch: StreamDeltaBatch) => void>()
    const buffer = createStreamDeltaBuffer(onFlush)

    // 顺序：thinking → text → thinking
    // 第一次 pushText 触发切换点 flush（把 't1' 推出去），然后 'x1' 入队
    // 第二次 pushThinking 不会触发 flush（lastTextKind === 'text' 不是 'thinking'）
    // 16ms 后再次 flush（'x1' + 't2'）
    buffer.pushThinking('msg_1', 't1')
    buffer.pushText('msg_1', 'x1')   // 触发切换点 flush → onFlush(['t1'])
    buffer.pushThinking('msg_1', 't2') // lastTextKind='text'，不会触发切换 flush

    // 已经发生过一次切换点 flush
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0][0]).toEqual([
      { kind: 'thinking', messageId: 'msg_1', delta: 't1' }
    ])

    advanceTime(16)
    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush.mock.calls[1][0]).toEqual([
      { kind: 'text', messageId: 'msg_1', delta: 'x1' },
      { kind: 'thinking', messageId: 'msg_1', delta: 't2' }
    ])

    buffer.dispose()
  })

  it('空 delta 字符串应被忽略', () => {
    const onFlush = vi.fn<(batch: StreamDeltaBatch) => void>()
    const buffer = createStreamDeltaBuffer(onFlush)

    buffer.pushText('msg_1', '')
    buffer.pushThinking('msg_1', '')
    buffer.pushToolCallDelta('msg_1', 'tc_1', '')

    advanceTime(1000)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('dispose 后再 push 不应触发 flush', () => {
    const onFlush = vi.fn<(batch: StreamDeltaBatch) => void>()
    const buffer = createStreamDeltaBuffer(onFlush)

    buffer.pushText('msg_1', 'a')
    buffer.dispose()

    advanceTime(1000)
    expect(onFlush).toHaveBeenCalledTimes(1) // dispose 内部已 flushNow 一次
  })

  it('dispose 内部应 flushNow 一次保证不丢内容', () => {
    const onFlush = vi.fn<(batch: StreamDeltaBatch) => void>()
    const buffer = createStreamDeltaBuffer(onFlush)

    buffer.pushText('msg_1', 'pre-dispose')

    expect(onFlush).not.toHaveBeenCalled()
    buffer.dispose()
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0][0]).toEqual([
      { kind: 'text', messageId: 'msg_1', delta: 'pre-dispose' }
    ])
  })

  it('flushNow 之后再次 push 应进入新一批', () => {
    const onFlush = vi.fn<(batch: StreamDeltaBatch) => void>()
    const buffer = createStreamDeltaBuffer(onFlush)

    buffer.pushText('msg_1', 'batch-1')
    buffer.flushNow()
    expect(onFlush).toHaveBeenCalledTimes(1)

    buffer.pushText('msg_1', 'batch-2')
    buffer.flushNow()
    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush.mock.calls[1][0]).toEqual([
      { kind: 'text', messageId: 'msg_1', delta: 'batch-2' }
    ])
  })

  it('Phase 2 切换点：第一次 pushText 且最近 push 是 thinking，应立即 flushNow 把思考刷出去', () => {
    const onFlush = vi.fn<(batch: StreamDeltaBatch) => void>()
    const buffer = createStreamDeltaBuffer(onFlush)

    buffer.pushThinking('msg_1', '思考中')
    // 还未到 16ms，立即 pushText → 触发切换点
    buffer.pushText('msg_1', '正文开始')

    // 切换点应立即 flush thinking
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0][0]).toEqual([
      { kind: 'thinking', messageId: 'msg_1', delta: '思考中' }
    ])

    // text delta 仍然在队列里等 16ms timer
    advanceTime(16)
    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush.mock.calls[1][0]).toEqual([
      { kind: 'text', messageId: 'msg_1', delta: '正文开始' }
    ])

    buffer.dispose()
  })

  it('切换点只在"紧跟 thinking"时触发；连续 text push 不会触发', () => {
    const onFlush = vi.fn<(batch: StreamDeltaBatch) => void>()
    const buffer = createStreamDeltaBuffer(onFlush)

    buffer.pushText('msg_1', 'a')
    buffer.pushText('msg_1', 'b')
    buffer.pushText('msg_1', 'c')

    // 不应有任何 flush
    expect(onFlush).not.toHaveBeenCalled()

    advanceTime(16)
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0][0]).toEqual([
      { kind: 'text', messageId: 'msg_1', delta: 'a' },
      { kind: 'text', messageId: 'msg_1', delta: 'b' },
      { kind: 'text', messageId: 'msg_1', delta: 'c' }
    ])
  })

  it('flushNow 在空缓冲上是 no-op（不调 onFlush）', () => {
    const onFlush = vi.fn<(batch: StreamDeltaBatch) => void>()
    const buffer = createStreamDeltaBuffer(onFlush)
    buffer.flushNow()
    expect(onFlush).not.toHaveBeenCalled()
  })
})
