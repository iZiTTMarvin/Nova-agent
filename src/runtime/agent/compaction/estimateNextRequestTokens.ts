/**
 * 下一步请求 token 估算：锚定上次 provider 真实 input usage，加上 signed 字符差。
 * 纯函数，无副作用。
 */
import type { ChatMessage } from '../../model/types'
import { CHARS_PER_TOKEN } from '../tokenEstimator'

/** 请求 payload 字符量（与 ContextBudgetManager 序列化口径一致） */
export function measureRequestPayloadChars(messages: readonly ChatMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), 'utf8')
}

export interface EstimateNextRequestTokensInput {
  /**
   * 上一步请求的真实 INPUT tokens（非 input+output）。
   * 冷启动或样本不可用时省略，回退到全量 payload 字符估算。
   */
  priorUsageTokens?: number
  /**
   * 相对上次已测请求 payload 的 signed 字符差。
   * 压缩/裁剪缩小投影后为负，估算必须计入缩小，否则仍按压缩前 usage 误判。
   */
  appendedChars: number
  /** 换算比；默认复用 tokenEstimator.CHARS_PER_TOKEN */
  charsPerToken?: number
  /** 无 usage 锚点时的全量 payload 字符 */
  coldStartChars?: number
}

/** 有锚点：inputTokens + delta/换算比；无锚点：全量 payload 字符估算 */
export function estimateNextRequestTokens(input: EstimateNextRequestTokensInput): number {
  const charsPerToken = Math.max(1, input.charsPerToken ?? CHARS_PER_TOKEN)
  if (input.priorUsageTokens !== undefined && Number.isFinite(input.priorUsageTokens)) {
    return Math.max(
      0,
      Math.max(0, Math.floor(input.priorUsageTokens)) +
        estimateSignedChars(input.appendedChars, charsPerToken)
    )
  }
  return Math.max(
    0,
    estimateSignedChars(input.coldStartChars ?? input.appendedChars, charsPerToken)
  )
}

/** 下一步估算是否越过高水位（contextWindow - reserve） */
export function exceedsHighWater(
  estimatedTokens: number,
  contextWindow: number,
  reserveTokens: number
): boolean {
  const highWater = Math.max(1, contextWindow - Math.max(0, reserveTokens))
  return estimatedTokens > highWater
}

function estimateSignedChars(chars: number | undefined, charsPerToken: number): number {
  const value = Math.trunc(chars ?? 0)
  if (!Number.isFinite(value) || value === 0) return 0
  const magnitude = Math.ceil(Math.abs(value) / charsPerToken)
  return value > 0 ? magnitude : -magnitude
}
