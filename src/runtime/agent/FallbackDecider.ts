/**
 * FallbackDecider — 模型降级决策器（PRD §5.4 优化版）
 *
 * 纯函数、无状态、无副作用，可独立单测。
 *
 * 设计原则（与 PRD §5.4 对齐）：
 * - 独立于 RecoveryStateMachine，后者只负责"错误分类 → 重试四态"。
 * - 本决策器只在主模型重试链耗尽后单独触发，二者职责正交。
 * - 不持有任何配置，所有参数由调用方传入。
 *
 * 规则：
 * - 当主模型重试已耗尽（attempt >= maxAttempts）且错误属于瞬态类
 *   且还有未试过的 fallback（nextIndex < fallbackCount）时，返回 shouldFallback: true。
 * - 否则返回 shouldFallback: false（由 AgentLoop 进入 failed 状态）。
 */
import type { ChatEvent } from '../model/types'

/** 决策结果 */
export interface FallbackDecision {
  /** 是否应该切换到下一个 fallback 模型 */
  shouldFallback: boolean
  /** 切换的目标 fallback 索引（shouldFallback=true 时有效） */
  nextFallbackIndex?: number
  /** 决策原因（供 UI 与日志展示） */
  reason: string
}

/** 决策输入 */
export interface FallbackDeciderInput {
  /** 当前错误文本 */
  currentError: string
  /** 当前模型（主或某 fallback）已重试次数 */
  retryAttempt: number
  /** 当前模型重试上限（与 RecoveryStateMachine 的 MAX_RETRY_ATTEMPTS 对齐） */
  maxAttempts: number
  /** 当前正在使用的 fallback 索引（0 表示主模型，1+ 表示第 N 个 fallback） */
  currentFallbackIndex: number
  /** 配置的 fallback 模型总数（不含主模型） */
  availableFallbackCount: number
}

/** 瞬态错误特征：与 RecoveryStateMachine.TRANSIENT_PATTERNS 保持一致 */
const TRANSIENT_PATTERNS = [
  /rate.?limit/i,
  /429/,
  /5\d{2}/,
  /timeout/i,
  /ECONNRESET/i,
  /network/i,
  /temporarily unavailable/i,
  /EBUSY/i,
  /EAGAIN/i
]

/** 判断错误是否属于瞬态（值得换模型重试） */
export function isTransientError(error: string): boolean {
  return TRANSIENT_PATTERNS.some(p => p.test(error))
}

/**
 * 判定是否应切换到下一个 fallback 模型。
 *
 * 切换条件全部满足：
 * 1. 主模型重试链已耗尽：retryAttempt >= maxAttempts
 * 2. 错误属于瞬态类（429/5xx/超时/网络），非瞬态错误换模型无意义
 * 3. 还有未试过的 fallback：currentFallbackIndex < availableFallbackCount
 */
export function decideFallback(input: FallbackDeciderInput): FallbackDecision {
  const { currentError, retryAttempt, maxAttempts, currentFallbackIndex, availableFallbackCount } = input

  // 条件 1：重试未耗尽，继续重试当前模型
  if (retryAttempt < maxAttempts) {
    return {
      shouldFallback: false,
      reason: `当前模型重试未耗尽（${retryAttempt}/${maxAttempts}），继续重试`
    }
  }

  // 条件 2：非瞬态错误，换模型无意义
  if (!isTransientError(currentError)) {
    return {
      shouldFallback: false,
      reason: '错误非瞬态类（非 429/5xx/超时/网络），切换备用模型无意义'
    }
  }

  // 条件 3：没有更多 fallback 可试
  const nextIndex = currentFallbackIndex + 1
  if (nextIndex > availableFallbackCount) {
    return {
      shouldFallback: false,
      reason: `所有 fallback 模型已耗尽（${availableFallbackCount} 个）`
    }
  }

  return {
    shouldFallback: true,
    nextFallbackIndex: nextIndex,
    reason: `主模型/当前 fallback 重试耗尽且错误瞬态，切换到第 ${nextIndex} 个 fallback 模型`
  }
}

/** 便捷：从 ChatEvent 流的 error 事件中提取错误文本 */
export function extractErrorText(event: { type: string; error?: string; rawError?: string }): string {
  if ('error' in event && typeof event.error === 'string') return event.error
  if ('rawError' in event && typeof event.rawError === 'string') return event.rawError
  return 'unknown error'
}

/** 便捷：从 ChatEvent error/context_overflow 事件提取（类型窄化） */
export function errorFromChatEvent(event: ChatEvent): string {
  if (event.type === 'error') return event.error
  if (event.type === 'context_overflow') return event.rawError
  return ''
}
