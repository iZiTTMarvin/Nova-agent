/**
 * RecoveryStateMachine — 错误恢复三态机（继续 / 重试 / 恢复）
 * 纯函数设计，不依赖 AgentLoop，便于单测
 *
 * 重试决策只消费结构化 ModelFailure 与调用方传入的 hasNoObservableOutput，
 * 不再对错误字符串做正则。字符串分类仅作为把「无 failure 伴随的旧字符串错误」
 * 补齐成 retryable 的兜底手段。
 */
import type { ChatMessage } from '../../model/types'
import type { ModelFailure } from '../../model/failureTypes'

/** 恢复状态联合类型 */
export type RecoveryState =
  | { kind: 'continuing' }
  | { kind: 'retrying'; attempt: number; lastError: string; maxAttempts: number }
  | { kind: 'recovering'; fromMessageId: string; snapshot: ChatMessage[] }
  | { kind: 'failed'; error: string }

/**
 * 主模型重试上限（export 供 FallbackDecider / AgentLoop 引用，避免硬编码不一致）。
 * 提高到 10；安全前提是调用方同时传入 hasNoObservableOutput 门闩——
 * 没有门闩的 10 次重试比 3 次更危险，二者必须同一次改动落地。
 */
export const MAX_RETRY_ATTEMPTS = 10

/** 退避基线（base 1s，max 32s，jitter 上界 0.25） */
const PROVIDER_RETRY_BASE_DELAY_MS = 1_000
const PROVIDER_RETRY_MAX_DELAY_MS = 32_000
const PROVIDER_RETRY_JITTER_FACTOR = 0.25

/** context overflow 触发恢复的特征（recovery 路径独立于重试门闩，正交保留） */
const OVERFLOW_PATTERNS = [/context.?overflow/i, /token.*limit/i, /maximum context/i, /context length/i]
const FUSE_PATTERNS = [/已自动中断/, /连续失败/]

export class RecoveryStateMachine {
  /**
   * 根据失败与当前尝试次数分类恢复状态。
   *
   * 优先消费结构化 failure（retryable）；当 failure 缺失时回退到错误字符串的
   * 正则分类——这是把旧调用路径（如流读取异常未携带 failure）补齐为可重试的兜底。
   *
   * context overflow 走独立的 recovering 态，与重试门闩正交，不在此处消费 failure。
   *
   * @param error 错误信息
   * @param attempt 已重试次数（从 0 起）
   * @param failure 结构化失败；存在时为决策真源
   */
  classify(error: string, attempt: number, failure?: ModelFailure): RecoveryState {
    if (FUSE_PATTERNS.some(p => p.test(error))) {
      return { kind: 'failed', error }
    }
    if (OVERFLOW_PATTERNS.some(p => p.test(error))) {
      return { kind: 'recovering', fromMessageId: '', snapshot: [] }
    }
    const retryable = failure ? failure.retryable : isLegacyTransientString(error)
    if (retryable) {
      if (attempt < MAX_RETRY_ATTEMPTS) {
        return { kind: 'retrying', attempt: attempt + 1, lastError: error, maxAttempts: MAX_RETRY_ATTEMPTS }
      }
      return { kind: 'failed', error: `重试 ${MAX_RETRY_ATTEMPTS} 次后仍失败: ${error}` }
    }
    return { kind: 'failed', error }
  }

  /** 是否应继续重试 */
  shouldRetry(state: RecoveryState): boolean {
    return state.kind === 'retrying' && state.attempt < state.maxAttempts
  }

  /** 构造注入下一轮上下文的恢复提示 */
  buildRecoveryHint(state: RecoveryState): string {
    switch (state.kind) {
      case 'retrying':
        return `[系统恢复提示] 上次请求失败（${state.lastError}），正在第 ${state.attempt}/${state.maxAttempts} 次重试，请继续。`
      case 'recovering':
        return '[系统恢复提示] 上下文溢出，已触发压缩恢复，请基于压缩后的历史继续。'
      case 'failed':
        return `[系统恢复提示] 无法自动恢复: ${state.error}`
      default:
        return ''
    }
  }

  /**
   * 指数退避毫秒数（base 1s × 2^(attempt-1)，上限 32s）。
   * 不含 jitter——返回确定性上界，便于单测断言退避序列；
   * 调用方（AttemptController）负责叠加 jitter。
   */
  backoffMs(attempt: number): number {
    const base = Math.min(
      PROVIDER_RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)),
      PROVIDER_RETRY_MAX_DELAY_MS
    )
    return Math.ceil(base)
  }

  /** jitter 上界（乘以 base）：供 AttemptController 叠加随机抖动 */
  jitterCeilMs(attempt: number): number {
    return Math.ceil(this.backoffMs(attempt) * PROVIDER_RETRY_JITTER_FACTOR)
  }
}

/**
 * 旧字符串错误的瞬态分类兜底。
 * 新路径优先走结构化 failure；这里只为没有 failure 伴随的流读取异常
 * 等保留可重试语义，与历史 TRANSIENT_PATTERNS 对齐。
 */
function isLegacyTransientString(error: string): boolean {
  return LEGACY_TRANSIENT_PATTERNS.some(p => p.test(error))
}

const LEGACY_TRANSIENT_PATTERNS = [
  /rate.?limit/i,
  /429/,
  /5\d{2}/,
  /timeout/i,
  /ECONNRESET/i,
  /network/i,
  /network_reset/i,
  /http_retryable/i,
  /temporarily unavailable/i,
  /文件.*占用/,
  /EBUSY/i,
  /EAGAIN/i
]
