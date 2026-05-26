export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 40

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

/** 统一计算“距底部还有多远”，避免组件里散落同一套数学逻辑。 */
export function getDistanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
}

/** 超过阈值说明用户已经主动上滚，此时流式阶段应暂停自动跟随。 */
export function shouldPauseAutoFollow(
  metrics: ScrollMetrics,
  threshold = AUTO_SCROLL_BOTTOM_THRESHOLD_PX
): boolean {
  return getDistanceFromBottom(metrics) > threshold
}

/**
 * 生成阶段的自动滚动调度器。
 *
 * 它只负责“同一帧内最多滚一次”和“允许在用户上滚时跳过自动跟随”，
 * 组件本身只关心什么时候 schedule / cancel，不再手写 rAF 细节。
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

export const browserFrameScheduler: FrameScheduler = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (frameId) => cancelAnimationFrame(frameId)
}
