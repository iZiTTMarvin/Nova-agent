import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  PROGRAMMATIC_SCROLL_GUARD_MS,
  STREAMING_AUTO_SCROLL_POLL_MS,
  STREAMING_AUTO_SCROLL_STOP_THRESHOLD_PX,
  canFollowAutoScroll,
  createStreamAutoScrollController,
  createStreamingScrollPoller,
  getDistanceFromBottom,
  isWithinProgrammaticScrollGuard,
  markProgrammaticScroll,
  scrollContainerToBottom,
  shouldPauseAutoFollow,
  syncAutoScrollModeOnScroll,
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
    let shouldSkip = true
    const controller = createStreamAutoScrollController(scrollToBottom, () => shouldSkip, frame.scheduler)

    controller.schedule()
    frame.flushNextFrame()
    expect(scrollToBottom).not.toHaveBeenCalled()

    shouldSkip = false
    controller.schedule()
    frame.flushNextFrame()
    expect(scrollToBottom).toHaveBeenCalledTimes(1)
    expect(AUTO_SCROLL_BOTTOM_THRESHOLD_PX).toBe(40)
  })

  it('scrollContainerToBottom 应对容器调用 scrollTo', () => {
    const scrollTo = vi.fn()
    const container = {
      scrollHeight: 1200,
      scrollTo
    } as unknown as HTMLElement

    scrollContainerToBottom(container)

    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: 'auto' })
  })

  it('程序滚动护栏应在标记后的一段时间内生效', () => {
    const ref = { current: 0 }
    const now = 1000
    markProgrammaticScroll(ref, now)
    expect(isWithinProgrammaticScrollGuard(ref.current, now + 50)).toBe(true)
    expect(isWithinProgrammaticScrollGuard(ref.current, now + PROGRAMMATIC_SCROLL_GUARD_MS)).toBe(false)
  })

  it('syncAutoScrollModeOnScroll 应在用户明显上滚远离底部时切到 off', () => {
    const metrics = {
      scrollHeight: 2000,
      scrollTop: 100,
      clientHeight: 400
    }
    const mode = syncAutoScrollModeOnScroll({
      metrics,
      previousScrollTop: 500,
      autoScrollMode: 'stream',
      isOutputting: true,
      isProgrammaticScroll: false
    })
    expect(mode).toBe('off')
    expect(getDistanceFromBottom(metrics)).toBeGreaterThan(STREAMING_AUTO_SCROLL_STOP_THRESHOLD_PX)
  })

  it('syncAutoScrollModeOnScroll 回到底部且仍在输出时应恢复 stream', () => {
    const metrics = {
      scrollHeight: 1000,
      scrollTop: 956,
      clientHeight: 400
    }
    const mode = syncAutoScrollModeOnScroll({
      metrics,
      previousScrollTop: 956,
      autoScrollMode: 'off',
      isOutputting: true,
      isProgrammaticScroll: false
    })
    expect(mode).toBe('stream')
  })

  it('canFollowAutoScroll 仅 stream/user 模式允许跟随', () => {
    expect(canFollowAutoScroll('stream')).toBe(true)
    expect(canFollowAutoScroll('user')).toBe(true)
    expect(canFollowAutoScroll('off')).toBe(false)
  })
})

describe('createStreamingScrollPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('轮询间隔内应调用 scrollToBottom', () => {
    const scrollToBottom = vi.fn()
    const poller = createStreamingScrollPoller({
      shouldPoll: () => true,
      shouldScroll: () => true,
      scrollToBottom,
      intervalMs: 100
    })

    poller.start()
    expect(scrollToBottom).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(scrollToBottom).toHaveBeenCalledTimes(1)

    poller.stop()
    vi.advanceTimersByTime(200)
    expect(scrollToBottom).toHaveBeenCalledTimes(1)
    expect(STREAMING_AUTO_SCROLL_POLL_MS).toBe(500)
  })

  it('shouldScroll 为 false 时不滚动', () => {
    const scrollToBottom = vi.fn()
    const poller = createStreamingScrollPoller({
      shouldPoll: () => true,
      shouldScroll: () => false,
      scrollToBottom,
      intervalMs: 100
    })

    poller.start()
    vi.advanceTimersByTime(300)
    expect(scrollToBottom).not.toHaveBeenCalled()
    poller.stop()
  })
})
