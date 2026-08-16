/**
 * ContextBudgetManager — 轮内预算估算。
 *
 * 本模块只保留仍在生产使用的职责：
 * - enforceInline：轮内只估算不改写，超预算交由门面触发压缩恢复
 * - ContextBudgetExceededError：压缩恢复链耗尽后的终态错误
 *
 * 当轮工具结果的裁剪由请求投影层（projectRequestMessages）负责，
 * 历史折叠的治理由 compaction 子模块各自处理。
 */
import type { ChatMessage } from '../model/types'

/** 轮内预算校验结果（只估算，不改写） */
export type InlineBudgetResult =
  | { status: 'within_budget'; estimatedTokens: number; serializedBytes: number }
  | { status: 'requires_compaction'; estimatedTokens: number; serializedBytes: number }

/** 超预算终态错误：压缩恢复链耗尽后抛出，供控制流精确区分 */
export class ContextBudgetExceededError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly serializedBytes: number,
    readonly attemptedCompaction: boolean
  ) {
    super(
      `ContextBudgetExceeded: estimatedTokens=${estimatedTokens} serializedBytes=${serializedBytes} attemptedCompaction=${attemptedCompaction}`
    )
    this.name = 'ContextBudgetExceededError'
  }
}

export interface ContextBudgetOptions {
  /** 估算 token 硬上限；超限则继续压缩，仍超则失败 */
  maxEstimatedTokens?: number
  /** 序列化字节硬上限 */
  maxSerializedBytes?: number
  /** 为模型输出预留的 token（从硬上限中扣除） */
  reservedOutputTokens?: number
}

/** 粗估：字符/4 ≈ token；序列化用 JSON 字节 */
export function estimateContextSize(messages: ChatMessage[]): { tokens: number; bytes: number } {
  const json = JSON.stringify(messages)
  const bytes = Buffer.byteLength(json, 'utf8')
  const tokens = Math.ceil(bytes / 4)
  return { tokens, bytes }
}

export class ContextBudgetManager {
  constructor(private readonly options: ContextBudgetOptions = {}) {}

  /**
   * 轮内入口：只估算与硬预算校验，不产出任何改写。
   * 超预算时返回 requires_compaction，由调用方决定恢复策略。
   */
  enforceInline(messages: ChatMessage[]): InlineBudgetResult {
    const { tokens, bytes } = estimateContextSize(messages)
    const maxTokens = this.options.maxEstimatedTokens
    const maxBytes = this.options.maxSerializedBytes
    const reserved = this.options.reservedOutputTokens ?? 0
    const tokenBudget = maxTokens != null ? Math.max(0, maxTokens - reserved) : undefined

    const exceeded =
      (tokenBudget != null && tokens > tokenBudget) || (maxBytes != null && bytes > maxBytes)

    return exceeded
      ? { status: 'requires_compaction', estimatedTokens: tokens, serializedBytes: bytes }
      : { status: 'within_budget', estimatedTokens: tokens, serializedBytes: bytes }
  }
}

/** 无硬上限的默认实例（仅测试/兼容）；生产路径必须用 createProductionContextBudgetManager */
export const defaultContextBudgetManager = new ContextBudgetManager()

/**
 * 与 createProductionContextBudgetManager / mid-turn 共用的输出预留与高水位。
 * 预留：min(8192, floor(contextWindow * 15%))；高水位：contextWindow - reserved。
 */
export function resolveProductionBudgetLimits(opts: {
  contextWindow: number
  reservedOutputTokens?: number
}): {
  reservedOutputTokens: number
  /** mid-turn 高水位；亦为生产预算器的 maxEstimatedTokens */
  highWaterTokens: number
  maxSerializedBytes: number
} {
  const reservedOutputTokens =
    opts.reservedOutputTokens ?? Math.min(8192, Math.floor(opts.contextWindow * 0.15))
  const highWaterTokens = Math.max(1024, opts.contextWindow - reservedOutputTokens)
  return {
    reservedOutputTokens,
    highWaterTokens,
    maxSerializedBytes: highWaterTokens * 4
  }
}

/** 按 contextWindow 创建带真实硬上限的预算器 */
export function createProductionContextBudgetManager(opts: {
  contextWindow: number
  reservedOutputTokens?: number
}): ContextBudgetManager {
  const { reservedOutputTokens, highWaterTokens, maxSerializedBytes } =
    resolveProductionBudgetLimits(opts)
  return new ContextBudgetManager({
    maxEstimatedTokens: highWaterTokens,
    maxSerializedBytes,
    reservedOutputTokens
  })
}
