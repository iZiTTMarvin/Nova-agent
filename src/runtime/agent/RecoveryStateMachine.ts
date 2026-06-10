/**
 * RecoveryStateMachine — 错误恢复三态机（继续 / 重试 / 恢复）
 * 纯函数设计，不依赖 AgentLoop，便于单测
 */
import type { ChatMessage } from '../model/types'

/** 恢复状态联合类型 */
export type RecoveryState =
  | { kind: 'continuing' }
  | { kind: 'retrying'; attempt: number; lastError: string; maxAttempts: number }
  | { kind: 'recovering'; fromMessageId: string; snapshot: ChatMessage[] }
  | { kind: 'failed'; error: string }

const MAX_RETRY_ATTEMPTS = 3
const TRANSIENT_PATTERNS = [
  /rate.?limit/i,
  /429/,
  /5\d{2}/,
  /timeout/i,
  /ECONNRESET/i,
  /network/i,
  /temporarily unavailable/i,
  /文件.*占用/,
  /EBUSY/i,
  /EAGAIN/i
]
const OVERFLOW_PATTERNS = [/context.?overflow/i, /token.*limit/i, /maximum context/i]
const FUSE_PATTERNS = [/已自动中断/, /连续失败/]

export class RecoveryStateMachine {
  /**
   * 根据错误文本与当前尝试次数分类恢复状态
   * @param error 错误信息
   * @param attempt 已重试次数（从 0 起）
   */
  classify(error: string, attempt: number): RecoveryState {
    if (FUSE_PATTERNS.some(p => p.test(error))) {
      return { kind: 'failed', error }
    }
    if (OVERFLOW_PATTERNS.some(p => p.test(error))) {
      return { kind: 'recovering', fromMessageId: '', snapshot: [] }
    }
    if (TRANSIENT_PATTERNS.some(p => p.test(error))) {
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

  /** 指数退避毫秒数 */
  backoffMs(attempt: number): number {
    return Math.min(1000 * Math.pow(2, attempt - 1), 8000)
  }
}
