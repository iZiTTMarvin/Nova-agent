/**
 * autoScroll — 聊天消息区自动滚动工具
 *
 * 设计参考 OpenCowork MessageList，在 nova 单会话 ChatPanel 落地：
 * - 对滚动容器 scrollTo（避免 scrollIntoView 对整棵 DOM 强制同步布局）
 * - 程序滚动护栏：区分「代码滚的」与「用户上滚」
 * - 流式期间 500ms 轮询（bash 输出撑高列表但无 text delta 时仍能跟随）
 * - render-pool tick 仍可用 rAF 合并为「同帧最多滚一次」作为补充
 */

/** 距底部在此阈值内视为「在底部」 */
export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 40

/** 用户上滚超过此距离时，停止流式自动跟随 */
export const STREAMING_AUTO_SCROLL_STOP_THRESHOLD_PX = 240

/** 程序滚动后的保护窗口：此期间内的 scroll 事件不算用户上滚 */
export const PROGRAMMATIC_SCROLL_GUARD_MS = 160

/** 流式输出期间自动滚动的轮询间隔 */
export const STREAMING_AUTO_SCROLL_POLL_MS = 500

/** 判定「用户主动上滚」的最小 scrollTop 回退量 */
export const SCROLL_UP_EPSILON_PX = 1

export type AutoScrollMode = 'off' | 'stream' | 'user'

export interface ScrollMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export interface FrameScheduler {
  requestFrame: (callback: () => void) => number
  cancelFrame: (frameId: number) => void
}

export interface StreamAutoScrollController {
  schedule: () => void
  cancel: () => void
}

/** 统一计算“距底部还有多远” */
export function getDistanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
}

/** 超过阈值说明用户已经主动上滚，此时流式阶段应暂停自动跟随 */
export function shouldPauseAutoFollow(
  metrics: ScrollMetrics,
  threshold = AUTO_SCROLL_BOTTOM_THRESHOLD_PX
): boolean {
  return getDistanceFromBottom(metrics) > threshold
}

/** 是否处于程序滚动保护窗口内 */
export function isWithinProgrammaticScrollGuard(
  programmaticScrollUntil: number,
  now: number = typeof performance !== 'undefined' ? performance.now() : Date.now()
): boolean {
  return now < programmaticScrollUntil
}

/** 标记接下来 PROGRAMMATIC_SCROLL_GUARD_MS 内的 scroll 来自代码 */
export function markProgrammaticScroll(
  programmaticScrollUntilRef: { current: number },
  now: number = typeof performance !== 'undefined' ? performance.now() : Date.now()
): number {
  const until = now + PROGRAMMATIC_SCROLL_GUARD_MS
  programmaticScrollUntilRef.current = until
  return until
}

/** 对滚动容器滚到底（不经过 scrollIntoView） */
export function scrollContainerToBottom(
  container: HTMLElement,
  behavior: ScrollBehavior = 'auto'
): void {
  container.scrollTo({ top: container.scrollHeight, behavior })
}

export interface SyncAutoScrollModeInput {
  metrics: ScrollMetrics
  previousScrollTop: number
  autoScrollMode: AutoScrollMode
  /** 会话是否仍在输出（生成中 / 工具执行等） */
  isOutputting: boolean
  isProgrammaticScroll: boolean
}

/**
 * 根据 scroll 事件同步自动滚动模式。
 *
 * - 用户明显上滚且远离底部 → off
 * - 回到底部且仍在输出 → stream
 */
export function syncAutoScrollModeOnScroll(input: SyncAutoScrollModeInput): AutoScrollMode {
  const distance = getDistanceFromBottom(input.metrics)
  const scrolledUp =
    input.metrics.scrollTop < input.previousScrollTop - SCROLL_UP_EPSILON_PX

  if (
    scrolledUp &&
    distance > STREAMING_AUTO_SCROLL_STOP_THRESHOLD_PX &&
    !input.isProgrammaticScroll
  ) {
    return 'off'
  }

  const atBottom = distance <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX
  if (atBottom && input.isOutputting && input.autoScrollMode === 'off') {
    return 'stream'
  }

  return input.autoScrollMode
}

/** 当前模式是否允许自动跟随 */
export function canFollowAutoScroll(mode: AutoScrollMode): boolean {
  return mode === 'user' || mode === 'stream'
}

/**
 * 生成阶段的 rAF 合并滚动调度器（render-pool tick 补充路径）。
 * 同一帧内多次 schedule 只执行一次 scrollToBottom。
 */
export function createStreamAutoScrollController(
  scrollToBottom: () => void,
  shouldSkipAutoScroll: () => boolean,
  frameScheduler: FrameScheduler
): StreamAutoScrollController {
  let frameId: number | null = null

  return {
    schedule: () => {
      if (frameId !== null) return

      frameId = frameScheduler.requestFrame(() => {
        frameId = null
        if (!shouldSkipAutoScroll()) {
          scrollToBottom()
        }
      })
    },
    cancel: () => {
      if (frameId === null) return
      frameScheduler.cancelFrame(frameId)
      frameId = null
    }
  }
}

export interface StreamingScrollPoller {
  start: () => void
  stop: () => void
}

/**
 * 流式期间的定时滚动轮询。
 * bash 输出撑高 scrollHeight 但无 text delta 时，仅靠轮询也能跟随底部。
 */
export function createStreamingScrollPoller(options: {
  shouldPoll: () => boolean
  shouldScroll: () => boolean
  scrollToBottom: () => void
  intervalMs?: number
}): StreamingScrollPoller {
  let intervalId: ReturnType<typeof setInterval> | null = null

  return {
    start: () => {
      if (intervalId !== null) return
      intervalId = setInterval(() => {
        if (!options.shouldPoll()) return
        if (!options.shouldScroll()) return
        options.scrollToBottom()
      }, options.intervalMs ?? STREAMING_AUTO_SCROLL_POLL_MS)
    },
    stop: () => {
      if (intervalId !== null) {
        clearInterval(intervalId)
        intervalId = null
      }
    }
  }
}

export const browserFrameScheduler: FrameScheduler = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (frameId) => cancelAnimationFrame(frameId)
}
