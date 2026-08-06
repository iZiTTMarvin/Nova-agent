/**
 * ContextBudgetManager — 轮内预算估算与压缩边界治理。
 *
 * 本模块只保留两条仍在生产使用的职责：
 * - enforceInline：轮内只估算不改写，超预算交由门面触发压缩恢复
 * - compactAtBoundary：正式压缩流程内的边界治理（artifact_ref + 内容哈希去重）
 *
 * 当轮工具结果的激进裁剪由请求投影层（projectRequestMessages）负责，
 * 历史折叠的 aging/supersede 由 compaction 子模块各自处理。
 */
import type { ChatMessage } from '../model/types'
import { extractTextFromContent } from '../model/types'
import {
  AGING_GROUP_BYTES_THRESHOLD,
  AGING_USER_TURN_THRESHOLD
} from './compaction/toolResultAging'
import { MIN_RECENT_MESSAGES, alignToToolGroupBoundary } from './compaction/compaction'

/** 单条 tool 结果超过此字节且带 artifact 时，压成 artifact+关键片段 */
export const BUDGET_ARTIFACT_BYTES = 16 * 1024

/** 可按路径判定「被替代」的工具名 */
const PATH_SCOPED_TOOLS = new Set(['read', 'edit', 'write', 'ls'])

/** 压缩 provenance 标记 */
export type BudgetProvenance =
  | 'full'
  | 'aged_summary'
  | 'artifact_ref'
  | 'superseded_removed'
  | 'budget_hard_trim'
  | 'content_hash_dedup'

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
  minRecentMessages?: number
  agingUserTurnThreshold?: number
  agingGroupBytesThreshold?: number
  artifactBytesThreshold?: number
  /** 估算 token 硬上限；超限则继续压缩，仍超则失败 */
  maxEstimatedTokens?: number
  /** 序列化字节硬上限 */
  maxSerializedBytes?: number
  /** 为模型输出预留的 token（从硬上限中扣除） */
  reservedOutputTokens?: number
}

export interface ContextBudgetResult {
  messages: ChatMessage[]
  provenance: Record<string, BudgetProvenance>
  /** 硬预算仍无法满足时为 true */
  exceededHardBudget?: boolean
  estimatedTokens?: number
  serializedBytes?: number
}


/** 粗估：字符/4 ≈ token；序列化用 JSON 字节 */
export function estimateContextSize(messages: ChatMessage[]): { tokens: number; bytes: number } {
  const json = JSON.stringify(messages)
  const bytes = Buffer.byteLength(json, 'utf8')
  const tokens = Math.ceil(bytes / 4)
  return { tokens, bytes }
}


function findToolName(messages: ChatMessage[], toolCallId: string): string | undefined {
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      const tc = m.toolCalls.find(t => t.id === toolCallId)
      if (tc) return tc.name
    }
  }
  return undefined
}

/** 路径作用域键：仅对 read/edit/write/ls 生效 */
function pathScopeKey(messages: ChatMessage[], toolCallId: string): string | null {
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue
    const tc = m.toolCalls.find(t => t.id === toolCallId)
    if (!tc) continue
    if (!PATH_SCOPED_TOOLS.has(tc.name)) return null
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(tc.arguments || '{}') as Record<string, unknown>
    } catch {
      args = {}
    }
    const pathVal =
      (typeof args.path === 'string' && args.path) ||
      (typeof args.filePath === 'string' && args.filePath) ||
      (typeof args.file_path === 'string' && args.file_path) ||
      ''
    if (!pathVal) return null
    return `${tc.name}::${pathVal}`
  }
  return null
}

function assertToolPairing(messages: ChatMessage[]): void {
  const toolIds = new Set(
    messages.filter(m => m.role === 'tool' && m.toolCallId).map(m => m.toolCallId!)
  )
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue
    for (const tc of m.toolCalls) {
      if (!toolIds.has(tc.id)) {
        console.warn(
          `[ContextBudgetManager] tool_call/tool_result 配对缺失: toolCallId=${tc.id} name=${tc.name}`
        )
      }
    }
  }
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

/**
 * 边界治理入口：仅在正式压缩流程内调用，入参是 splitForCompaction 切分后的旧段。
 * v1 只做两类改写：artifact_ref（>16KB 且带 artifactId）+ 内容哈希精确去重。
 * 不做路径型 supersede、不做 aging、不做 hardTrim。
 */
export function compactAtBoundary(
  oldMessages: ChatMessage[],
  options: ContextBudgetOptions = {}
): { messages: ChatMessage[]; provenance: Record<string, BudgetProvenance> } {
  const artifactThreshold = options.artifactBytesThreshold ?? BUDGET_ARTIFACT_BYTES
  const provenance: Record<string, BudgetProvenance> = {}
  const result = oldMessages.slice()

  const nsIdx: number[] = []
  const ns: ChatMessage[] = []
  for (let i = 0; i < result.length; i++) {
    if (result[i].role !== 'system') {
      nsIdx.push(i)
      ns.push(result[i])
    }
  }

  // 1) artifact_ref：原始输出 > 16KB 且带 artifactId
  for (let i = 0; i < ns.length; i++) {
    const msg = ns[i]
    if (msg.role !== 'tool' || !msg.toolCallId || !msg.artifactId) continue

    const text = extractTextFromContent(msg.content)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > artifactThreshold) {
      const toolName = findToolName(ns, msg.toolCallId) ?? 'unknown'
      const head = text.split('\n')[0]?.slice(0, 200) ?? ''
      result[nsIdx[i]!] = {
        ...msg,
        content: `[artifact ref] ${toolName}(artifact://${msg.artifactId}): ${head}`
      }
      provenance[msg.toolCallId] = 'artifact_ref'
    }
  }

  // 2) 内容哈希精确去重：同路径 + 同内容 hash 时，较旧者换占位符
  const contentHashByPathKey = new Map<string, { hash: string; toolCallId: string }>()
  for (let i = ns.length - 1; i >= 0; i--) {
    const msg = result[nsIdx[i]!]
    if (msg.role !== 'tool' || !msg.toolCallId) continue
    const key = pathScopeKey(ns, msg.toolCallId)
    if (!key) continue

    const text = extractTextFromContent(msg.content)
    if (text.startsWith('[artifact ref]') || text.startsWith('[content hash dedup]')) continue

    const hash = simpleContentHash(text)
    if (!contentHashByPathKey.has(key)) {
      contentHashByPathKey.set(key, { hash, toolCallId: msg.toolCallId })
    } else {
      const latest = contentHashByPathKey.get(key)!
      if (latest.hash === hash && latest.toolCallId !== msg.toolCallId) {
        const toolName = findToolName(ns, msg.toolCallId) ?? 'unknown'
        result[nsIdx[i]!] = {
          ...msg,
          content: `[content hash dedup] ${toolName}: (identical to later ${key})`
        }
        provenance[msg.toolCallId] = 'content_hash_dedup'
      }
    }
  }

  for (const msg of result) {
    if (msg.role === 'tool' && msg.toolCallId && !provenance[msg.toolCallId]) {
      provenance[msg.toolCallId] = 'full'
    }
  }

  assertToolPairing(result)
  return { messages: result, provenance }
}

/** 轻量内容哈希（djb2 变体，用于精确去重判定） */
function simpleContentHash(text: string): string {
  let h1 = 5381
  let h2 = 52711
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = ((h1 << 5) + h1 + c) | 0
    h2 = ((h2 << 5) + h2 + c) | 0
  }
  return `${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}_${text.length}`
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
    reservedOutputTokens,
    agingUserTurnThreshold: AGING_USER_TURN_THRESHOLD,
    agingGroupBytesThreshold: AGING_GROUP_BYTES_THRESHOLD
  })
}

export { AGING_GROUP_BYTES_THRESHOLD, AGING_USER_TURN_THRESHOLD }
