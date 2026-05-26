import { describe, expect, it, vi } from 'vitest'
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  createStreamAutoScrollController,
  getDistanceFromBottom,
  shouldPauseAutoFollow,
  type FrameScheduler
} from '../../../src/renderer/features/chat/autoScroll'

function createFakeFrameScheduler() {
  let nextId = 1
  const callbacks = new Map<number, () => void>()

  const scheduler: FrameScheduler = {
    requestFrame: vi.fn((callback: () => void) => {
      const frameId = nextId++
      callbacks.set(frameId, callback)
      return frameId
    }),
    cancelFrame: vi.fn((frameId: number) => {
      callbacks.delete(frameId)
    })
  }

  return {
    scheduler,
    flushNextFrame: () => {
      const nextEntry = callbacks.entries().next().value as [number, () => void] | undefined
      if (!nextEntry) return
      const [frameId, callback] = nextEntry
      callbacks.delete(frameId)
      callback()
    },
    getPendingFrameCount: () => callbacks.size
  }
}

describe('autoScroll', () => {
  it('应正确计算距底部距离并按阈值判断是否暂停自动跟随', () => {
    const metrics = { scrollHeight: 820, scrollTop: 560, clientHeight: 220 }

    expect(getDistanceFromBottom(metrics)).toBe(40)
    expect(shouldPauseAutoFollow(metrics)).toBe(false)
    expect(
      shouldPauseAutoFollow({
        ...metrics,
        scrollTop: metrics.scrollTop - 1
      })
    ).toBe(true)
  })

  it('生成阶段的自动滚动应在同一帧内合并为一次调度', () => {
    const frame = createFakeFrameScheduler()
    const scrollToBottom = vi.fn()
    const controller = createStreamAutoScrollController(scrollToBottom, () => false, frame.scheduler)

    controller.schedule()
    controller.schedule()
    controller.schedule()

    expect(frame.scheduler.requestFrame).toHaveBeenCalledTimes(1)
    expect(frame.getPendingFrameCount()).toBe(1)

    frame.flushNextFrame()

    expect(scrollToBottom).toHaveBeenCalledTimes(1)
    expect(frame.getPendingFrameCount()).toBe(0)
  })

  it('取消后不应再执行已排队的自动滚动', () => {
    const frame = createFakeFrameScheduler()
    const scrollToBottom = vi.fn()
    const controller = createStreamAutoScrollController(scrollToBottom, () => false, frame.scheduler)

    controller.schedule()
    controller.cancel()
    frame.flushNextFrame()

    expect(frame.scheduler.cancelFrame).toHaveBeenCalledTimes(1)
    expect(scrollToBottom).not.toHaveBeenCalled()
  })

  it('用户主动上滚时应跳过自动滚动，直到用户回到底部附近', () => {
    const frame = createFakeFrameScheduler()
    const scrollToBottom = vi.fn()
    let userScrolledUp = true
    const controller = createStreamAutoScrollController(scrollToBottom, () => userScrolledUp, frame.scheduler)

    controller.schedule()
    frame.flushNextFrame()
    expect(scrollToBottom).not.toHaveBeenCalled()

    userScrolledUp = false
    controller.schedule()
    frame.flushNextFrame()
    expect(scrollToBottom).toHaveBeenCalledTimes(1)
    expect(AUTO_SCROLL_BOTTOM_THRESHOLD_PX).toBe(40)
  })
})
