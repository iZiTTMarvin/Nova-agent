import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  configureStreamDeltaScheduler,
  flushStreamDeltasNow,
  scheduleStreamDelta,
  pushTextDelta,
  pushThinkingDelta,
  pushToolCallDelta,
  resetStreamDeltaScheduler
} from '../../../src/renderer/lib/streamDeltaScheduler'
import type { StreamDeltaBatch } from '../../../src/renderer/stores/useChatStore'

describe('streamDeltaScheduler', () => {
  let pendingFrames: Array<() => void> = []
  let nextFrameId = 1
  let applyMock: (batch: StreamDeltaBatch) => void

  beforeEach(() => {
    pendingFrames = []
    nextFrameId = 1
    applyMock = vi.fn<(batch: StreamDeltaBatch) => void>()
    configureStreamDeltaScheduler({
      requestFrame: (cb) => {
        const id = nextFrameId++
        pendingFrames.push(cb)
        return id
      },
      cancelFrame: (handle) => {
        pendingFrames.splice(pendingFrames.indexOf(pendingFrames[handle - 1] ?? (() => undefined)), 1)
      },
      apply: applyMock
    })
  })

  afterEach(() => {
    resetStreamDeltaScheduler()
  })

  function flushFrame(): void {
    const frames = pendingFrames
    pendingFrames = []
    for (const f of frames) f()
  }

  it('单次 push 后 rAF 触发一次 apply，批内保留顺序', () => {
    pushTextDelta('m1', 'a')
    pushTextDelta('m1', 'b')
    pushToolCallDelta('m1', 'tc1', 'c')
    pushThinkingDelta('m1', 'd')

    expect(applyMock).not.toHaveBeenCalled()

    flushFrame()
    expect(applyMock).toHaveBeenCalledTimes(1)
    expect(applyMock).toHaveBeenCalledWith([
      { kind: 'text', messageId: 'm1', delta: 'a' },
      { kind: 'text', messageId: 'm1', delta: 'b' },
      { kind: 'toolCall', messageId: 'm1', toolCallId: 'tc1', delta: 'c' },
      { kind: 'thinking', messageId: 'm1', delta: 'd' }
    ])
  })

  it('已调度 rAF 时再 push 不应重复安排', () => {
    pushTextDelta('m1', 'a')
    pushTextDelta('m1', 'b')
    pushTextDelta('m1', 'c')

    // 三次 push 只产生一次 frame 调度
    expect(pendingFrames).toHaveLength(1)

    flushFrame()
    expect(applyMock).toHaveBeenCalledTimes(1)
    expect(applyMock.mock.calls[0][0]).toHaveLength(3)
  })

  it('flushStreamDeltasNow 立即刷出待发 delta（无需等 rAF）', () => {
    pushTextDelta('m1', 'a')
    pushTextDelta('m1', 'b')

    flushStreamDeltasNow()
    expect(applyMock).toHaveBeenCalledTimes(1)
    expect(applyMock.mock.calls[0][0]).toEqual([
      { kind: 'text', messageId: 'm1', delta: 'a' },
      { kind: 'text', messageId: 'm1', delta: 'b' }
    ])

    // flushNow 后 pending 清空，再推进 rAF 不应再触发
    flushFrame()
    expect(applyMock).toHaveBeenCalledTimes(1)
  })

  it('rAF flush 之后再次 push 应进入新一批', () => {
    pushTextDelta('m1', 'batch-1')
    flushFrame()
    expect(applyMock).toHaveBeenCalledTimes(1)

    pushTextDelta('m1', 'batch-2-a')
    pushTextDelta('m1', 'batch-2-b')
    flushFrame()
    expect(applyMock).toHaveBeenCalledTimes(2)
    expect(applyMock.mock.calls[1][0]).toHaveLength(2)
  })

  it('空 delta 应被忽略', () => {
    pushTextDelta('m1', '')
    pushThinkingDelta('m1', '')
    pushToolCallDelta('m1', 'tc1', '')

    flushFrame()
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('resetStreamDeltaScheduler 清空队列并取消挂起的 rAF', () => {
    pushTextDelta('m1', 'a')
    pushTextDelta('m1', 'b')
    expect(pendingFrames).toHaveLength(1)

    resetStreamDeltaScheduler()
    expect(pendingFrames).toHaveLength(0)

    flushFrame()
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('buffer + scheduler 集成：buffer 的 onFlush 应通过 scheduleStreamDelta 投递（不直接调 apply）', () => {
    // C1 修复后的关键集成：buffer 自己不调 apply，
    // 而是遍历 batch 调 scheduleStreamDelta；scheduler 统一聚合到 rAF。
    // 这里不依赖 buffer 内部 setTimeout（已由 streamDeltaBuffer.test.ts 覆盖），
    // 只验证"如果 buffer 调了 scheduleStreamDelta，scheduler 行为正确"。

    // 模拟 buffer 的 onFlush 行为：分两个 batch 投递
    const batch1: StreamDeltaBatch = [
      { kind: 'text', messageId: 'm1', delta: 'a' },
      { kind: 'text', messageId: 'm1', delta: 'b' }
    ]
    for (const delta of batch1) scheduleStreamDelta(delta)

    // 安排了一次 rAF
    expect(pendingFrames).toHaveLength(1)
    expect(applyMock).not.toHaveBeenCalled()

    // 第一帧 flush：apply 被调用一次，batch1 全部传入
    flushFrame()
    expect(applyMock).toHaveBeenCalledTimes(1)
    expect(applyMock.mock.calls[0][0]).toHaveLength(2)

    // 模拟 buffer 的第二次 flush
    const batch2: StreamDeltaBatch = [
      { kind: 'toolCall', messageId: 'm1', toolCallId: 'tc1', delta: 'c' }
    ]
    for (const delta of batch2) scheduleStreamDelta(delta)

    // 第二次 rAF 调度
    expect(pendingFrames).toHaveLength(1)

    // 第二次 flush
    flushFrame()
    expect(applyMock).toHaveBeenCalledTimes(2)
    expect(applyMock.mock.calls[1][0]).toHaveLength(1)
    expect(applyMock.mock.calls[1][0][0]).toEqual({
      kind: 'toolCall',
      messageId: 'm1',
      toolCallId: 'tc1',
      delta: 'c'
    })
  })

  it('buffer onFlush 配合 scheduleStreamDelta：单帧内多个 buffer 来源应被合并为一次 apply', () => {
    // 场景：buffer A flush + buffer B flush 都在同一帧内调度（罕见但可能）
    // 期望：scheduler 把它们合并到一次 apply 调用
    const a1: StreamDeltaBatch = [{ kind: 'text', messageId: 'm1', delta: 'a' }]
    const b1: StreamDeltaBatch = [{ kind: 'text', messageId: 'm1', delta: 'b' }]

    for (const delta of a1) scheduleStreamDelta(delta)
    // 注意：第二帧的 rAF 还没 flush，所以下面这一行不会重复安排
    for (const delta of b1) scheduleStreamDelta(delta)

    // 仍然只有 1 个 rAF 待调度
    expect(pendingFrames).toHaveLength(1)

    // flush 一次：apply 收到 2 个 delta（合并）
    flushFrame()
    expect(applyMock).toHaveBeenCalledTimes(1)
    expect(applyMock.mock.calls[0][0]).toHaveLength(2)
  })
})
