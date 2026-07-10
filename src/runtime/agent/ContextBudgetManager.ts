/**
 * ContextBudgetManager — 工具轮次统一上下文预算器
 *
 * compaction 与 aging 共用本模块，避免两套规则互覆盖。
 * 策略：
 * - 最近且仍被引用 → 全文保留
 * - 较旧 → 结构化摘要（aging 占位）
 * - 大输出且有 artifact → artifact + 关键片段（优先于纯 aging）
 * - 同路径读写被后续结果替代 → 删除正文（保留配对骨架）
 *
 * 保证 tool_call / tool_result 配对合法，并记录压缩 provenance。
 */
import type { ChatMessage } from '../model/types'
import { extractTextFromContent } from '../model/types'
import {
  ageToolResults,
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

/**
 * 对上下文应用统一预算。不 mutate 入参。
 * 顺序：aging 摘要 → 大输出 artifact 覆盖 → 同路径 supersede。
 */
export function applyContextBudget(
  context: ChatMessage[],
  options: ContextBudgetOptions = {}
): ContextBudgetResult {
  const minRecent = options.minRecentMessages ?? MIN_RECENT_MESSAGES
  const artifactThreshold = options.artifactBytesThreshold ?? BUDGET_ARTIFACT_BYTES
  const provenance: Record<string, BudgetProvenance> = {}

  // 1) 共用 aging
  let result = ageToolResults(context)

  // 记录 aging provenance（相对原始 context）
  for (let i = 0; i < result.length; i++) {
    const before = context[i]
    const after = result[i]
    if (
      before?.role === 'tool' &&
      after?.role === 'tool' &&
      before.toolCallId &&
      extractTextFromContent(before.content) !== extractTextFromContent(after.content)
    ) {
      const text = extractTextFromContent(after.content)
      if (text.startsWith('[aged tool result]')) {
        provenance[before.toolCallId] = 'aged_summary'
      }
    }
  }

  // 2) 大输出 + artifact → artifact_ref（覆盖 aging，优先保留可续读指针）
  const nsIdx: number[] = []
  const ns: ChatMessage[] = []
  for (let i = 0; i < result.length; i++) {
    if (result[i].role !== 'system') {
      nsIdx.push(i)
      ns.push(result[i])
    }
  }

  if (ns.length === 0) {
    return { messages: result, provenance }
  }

  let splitIndex = Math.max(0, ns.length - minRecent)
  splitIndex = alignToToolGroupBoundary(ns, splitIndex)

  for (let i = 0; i < ns.length; i++) {
    const msg = ns[i]
    if (msg.role !== 'tool' || !msg.toolCallId) continue
    if (i >= splitIndex) continue
    if (!msg.artifactId) continue

    // 原始字节（用 context 同位置）判断是否「大输出」
    const original = context[nsIdx[i]!]
    const originalText = original ? extractTextFromContent(original.content) : ''
    const originalBytes = Buffer.byteLength(originalText, 'utf8')
    const alreadyAged = extractTextFromContent(msg.content).startsWith('[aged tool result]')

    if (originalBytes > artifactThreshold || alreadyAged) {
      const toolName = findToolName(ns, msg.toolCallId) ?? 'unknown'
      const head = originalText.split('\n')[0]?.slice(0, 200) ?? ''
      result[nsIdx[i]!] = {
        ...msg,
        content: `[artifact ref] ${toolName}(artifact://${msg.artifactId}): ${head}`
      }
      provenance[msg.toolCallId] = 'artifact_ref'
    }
  }

  // 3) 同路径 supersede（保护区外、非最新）
  const latestByPathKey = new Map<string, string>()
  for (let i = ns.length - 1; i >= 0; i--) {
    const msg = result[nsIdx[i]!]
    if (msg.role !== 'tool' || !msg.toolCallId) continue
    const key = pathScopeKey(ns, msg.toolCallId)
    if (!key) continue
    if (!latestByPathKey.has(key)) latestByPathKey.set(key, msg.toolCallId)
  }

  for (let i = 0; i < ns.length; i++) {
    const msg = result[nsIdx[i]!]
    if (msg.role !== 'tool' || !msg.toolCallId) continue
    if (i >= splitIndex) continue
    const key = pathScopeKey(ns, msg.toolCallId)
    if (!key) continue
    if (latestByPathKey.get(key) === msg.toolCallId) continue

    const text = extractTextFromContent(msg.content)
    if (text.startsWith('[superseded tool result]')) continue

    const toolName = findToolName(ns, msg.toolCallId) ?? 'unknown'
    result[nsIdx[i]!] = {
      ...msg,
      content: `[superseded tool result] ${toolName}: (replaced by later ${key})`
    }
    provenance[msg.toolCallId] = 'superseded_removed'
  }

  for (const msg of result) {
    if (msg.role === 'tool' && msg.toolCallId && !provenance[msg.toolCallId]) {
      provenance[msg.toolCallId] = 'full'
    }
  }

  assertToolPairing(result)

  // 4) 硬预算：仍超限则从保护区外继续把大 tool 结果压成短摘要
  const maxTokens = options.maxEstimatedTokens
  const maxBytes = options.maxSerializedBytes
  const reserved = options.reservedOutputTokens ?? 0
  if (maxTokens != null || maxBytes != null) {
    const tokenBudget = maxTokens != null ? Math.max(0, maxTokens - reserved) : undefined
    let { tokens, bytes } = estimateContextSize(result)
    let guard = 0
    let allowRecent = false
    while (
      ((tokenBudget != null && tokens > tokenBudget) || (maxBytes != null && bytes > maxBytes)) &&
      guard < 80
    ) {
      guard++
      const trimmed = hardTrimOldestToolOutsideRecent(
        result,
        minRecent,
        provenance,
        allowRecent
      )
      if (!trimmed) {
        if (!allowRecent) {
          allowRecent = true
          continue
        }
        break
      }
      result = trimmed
      ;({ tokens, bytes } = estimateContextSize(result))
    }
    const exceeded =
      (tokenBudget != null && tokens > tokenBudget) || (maxBytes != null && bytes > maxBytes)
    assertToolPairing(result)
    return {
      messages: result,
      provenance,
      exceededHardBudget: exceeded,
      estimatedTokens: tokens,
      serializedBytes: bytes
    }
  }

  return { messages: result, provenance }
}

/** 粗估：字符/4 ≈ token；序列化用 JSON 字节 */
export function estimateContextSize(messages: ChatMessage[]): { tokens: number; bytes: number } {
  const json = JSON.stringify(messages)
  const bytes = Buffer.byteLength(json, 'utf8')
  const tokens = Math.ceil(bytes / 4)
  return { tokens, bytes }
}

/**
 * 在保护区外找最大的 tool 结果压成短摘要；找不到可压项返回 null。
 * allowRecent=true 时允许压缩保护区内（仍保留最后一组 tool 配对）。
 */
function hardTrimOldestToolOutsideRecent(
  messages: ChatMessage[],
  minRecent: number,
  provenance: Record<string, BudgetProvenance>,
  allowRecent = false
): ChatMessage[] | null {
  const nsIdx: number[] = []
  const ns: ChatMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'system') {
      nsIdx.push(i)
      ns.push(messages[i])
    }
  }
  if (ns.length === 0) return null
  let splitIndex = Math.max(0, ns.length - minRecent)
  splitIndex = alignToToolGroupBoundary(ns, splitIndex)
  // 硬预算二次阶段：可压到「最后一组 tool」之前
  const hardEnd = allowRecent
    ? Math.max(0, alignToToolGroupBoundary(ns, Math.max(0, ns.length - 3)))
    : splitIndex

  let bestIdx = -1
  let bestBytes = 0
  for (let i = 0; i < hardEnd; i++) {
    const msg = ns[i]
    if (msg.role !== 'tool' || !msg.toolCallId) continue
    const text = extractTextFromContent(msg.content)
    if (text.startsWith('[budget hard trim]')) continue
    const b = Buffer.byteLength(text, 'utf8')
    if (b > bestBytes) {
      bestBytes = b
      bestIdx = i
    }
  }
  if (bestIdx < 0 || bestBytes < 64) return null

  const target = ns[bestIdx]!
  const out = messages.slice()
  const abs = nsIdx[bestIdx]!
  const toolName = findToolName(ns, target.toolCallId!) ?? 'unknown'
  out[abs] = {
    ...target,
    content: `[budget hard trim] ${toolName}: (removed ${bestBytes} bytes to meet hard budget)`
  }
  provenance[target.toolCallId!] = 'budget_hard_trim'
  return out
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

  apply(context: ChatMessage[]): ChatMessage[] {
    return applyContextBudget(context, this.options).messages
  }

  applyWithProvenance(context: ChatMessage[]): ContextBudgetResult {
    return applyContextBudget(context, this.options)
  }
}

export const defaultContextBudgetManager = new ContextBudgetManager()

export { AGING_GROUP_BYTES_THRESHOLD, AGING_USER_TURN_THRESHOLD }
