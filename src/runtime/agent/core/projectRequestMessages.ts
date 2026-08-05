/**
 * 请求投影层：将"权威上下文"（context.messages）与"本次模型请求看到的消息"（chatMessages）分离。
 *
 * 三条纪律：
 * 1. 投影结果绝不写回 context.messages——context.messages 永远保留全文，是权威事实。
 * 2. 溢出压缩恢复后必须重新投影（调用方的 continue 路径回到循环顶会重新执行投影；若未来有人把恢复改成就地重试，必须显式重新投影）。
 * 3. 投影是幂等的——对已是占位符的内容再次投影原样返回。
 */
import type { ChatMessage } from '../../model/types'

/** 当轮工具结果归档策略 */
export interface ActiveToolResultPrunePolicy {
  enabled: boolean
  /** 归档阈值（估算 token） */
  maxEstimatedTokens?: number
  /** 起始归档轮次（第 0 轮不改写） */
  minToolRound?: number
}

/** 归档候选：一份待写入 artifact 的工具结果原文 */
export interface ArchiveCandidate {
  toolCallId: string
  toolName: string
  body: string
  /** body 的 sha256，用作缓存键与 lineage 依据 */
  bodySha256: string
}

export interface RequestProjectionInput {
  messages: ChatMessage[]
  toolRound: number
  policy: ActiveToolResultPrunePolicy
  /**
   * 写入 artifact。返回 null 表示写入失败（调用方保留原文并计入诊断）。
   * 契约：实现方不得抛异常，所有失败都必须表达为 null。
   */
  archive: (input: ArchiveCandidate) => Promise<{ artifactId: string } | null>
}

export interface RequestProjectionDiagnostics {
  prunedCount: number
  archiveFailures: number
  estimatedTokensSaved: number
}

export interface RequestProjectionResult {
  messages: ChatMessage[]
  /** 诊断用，不进模型上下文 */
  diagnostics: RequestProjectionDiagnostics
}

const EMPTY_DIAGNOSTICS: RequestProjectionDiagnostics = {
  prunedCount: 0,
  archiveFailures: 0,
  estimatedTokensSaved: 0
}

/** 关闭态策略：门面默认值 */
export const DISABLED_PRUNE_POLICY: ActiveToolResultPrunePolicy = { enabled: false }

export async function projectRequestMessages(
  input: RequestProjectionInput
): Promise<RequestProjectionResult> {
  if (!input.policy.enabled) {
    return { messages: input.messages, diagnostics: EMPTY_DIAGNOSTICS }
  }
  // 归档逻辑待启用后填充
  return { messages: input.messages, diagnostics: EMPTY_DIAGNOSTICS }
}
