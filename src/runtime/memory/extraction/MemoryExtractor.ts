/**
 * MemoryExtractor — 会话消息 + 工具轨迹 → 记忆候选（LLM 只负责语义理解）
 *
 * 自我污染防护落在输入投影与证据溯源两层：
 * - 投影剔除 internal / skipCacheMarker 临时消息（动态注入内容进入会话的唯一形态）；
 * - evidence excerpt 必须逐字命中同角色输入文本，助手复述无法冒充用户/工具证据。
 * fail-soft：任何异常返回 null，不 throw，不影响主对话。
 */
import type { ChatMessage } from '../../model/types'
import { extractTextFromContent } from '../../model/types'
import type { MemoryObservation } from '../ObservationCapture'
import { filterPrivacyText } from '../PrivacyFilter'
import {
  MEMORY_CANDIDATE_CONTENT_MAX_CHARS,
  MEMORY_EVIDENCE_EXCERPT_MAX_CHARS,
  MEMORY_EXTRACT_WINDOW_SIZE,
  MEMORY_KEY_MAX_CHARS
} from '../memoryConfig'
import {
  EXPLICITNESS_LEVELS,
  MEMORY_CANDIDATE_INTENTS,
  MEMORY_EVIDENCE_TYPES,
  MEMORY_KINDS,
  SCOPE_HINTS
} from '../types'
import type {
  MemoryCandidate,
  MemoryCandidateEvidence,
  MemoryCandidateIntent,
  MemoryEvidenceType
} from '../types'
import { buildExtractMessages } from './memoryPrompts'

/** 提炼模块依赖口子：chat 由宿主装配（独立 ModelClient，不复用主对话 pool） */
export interface MemoryExtractorDeps {
  chat: (messages: ChatMessage[], opts?: { reasoningEffort?: 'low' }) => Promise<string>
}

/** 硬编码：覆盖主模型 thinking 强度 */
export const EXTRACT_REASONING_EFFORT = 'low' as const

export interface MemoryExtractionInput {
  sessionId: string
  recentMessages: readonly ChatMessage[]
  observations: readonly MemoryObservation[]
}

/** 证据溯源域：按角色分组的原文文本（规范化空白与大小写后做逐字包含判定） */
export interface EvidenceProvenance {
  userTexts: readonly string[]
  toolTexts: readonly string[]
}

export class MemoryExtractor {
  constructor(private readonly deps: MemoryExtractorDeps) {}

  /**
   * 把最近会话 + 工具轨迹提炼为记忆候选。
   * 返回 null 表示整体失败（宿主走零 LLM 降级）；空数组表示无可提取内容。
   */
  async extract(input: MemoryExtractionInput): Promise<MemoryCandidate[] | null> {
    try {
      const projected = projectExtractionMessages(input.recentMessages).slice(
        -MEMORY_EXTRACT_WINDOW_SIZE
      )
      const observations = input.observations.filter(observation => observation.toolName !== 'memory_search')
      if (projected.length === 0 && observations.length === 0) {
        return null
      }

      const messages = buildExtractMessages({
        sessionId: input.sessionId,
        messages: projected,
        observations
      })
      const raw = await this.deps.chat(messages, { reasoningEffort: EXTRACT_REASONING_EFFORT })
      const provenance = buildEvidenceProvenance(projected, observations)
      const parsed = parseMemoryCandidateResponse(raw, provenance)
      return parsed === null ? null : parsed.candidates
    } catch {
      return null
    }
  }
}

/**
 * 提炼输入投影：只保留真实会话消息。
 * internal / skipCacheMarker 是运行时临时注入标记（压缩指令、动态记忆块等），
 * 这类内容禁止作为提炼输入，否则注入的记忆会被再次「学习」。
 */
export function projectExtractionMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const memoryCalls = new Set(messages.flatMap(message =>
    (message.toolCalls ?? []).filter(call => call.name === 'memory_search').map(call => call.id)
  ))
  return messages.filter((m) => !m.internal && !m.skipCacheMarker && m.role !== 'system'
    && !(m.role === 'assistant' && !extractTextFromContent(m.content).trim()
      && m.toolCalls?.length && m.toolCalls.every(call => call.name === 'memory_search'))
    && !(m.role === 'tool' && m.toolCallId && memoryCalls.has(m.toolCallId)))
}

/** 从投影后的消息与 observation 构建证据溯源域 */
export function buildEvidenceProvenance(
  messages: readonly ChatMessage[],
  observations: readonly MemoryObservation[]
): EvidenceProvenance {
  const userTexts: string[] = []
  const toolTexts: string[] = []
  for (const msg of messages) {
    const text = normalizeForMatch(extractTextFromContent(msg.content))
    if (!text) {
      continue
    }
    if (msg.role === 'user') {
      userTexts.push(text)
    } else if (msg.role === 'tool') {
      toolTexts.push(text)
    }
  }
  for (const obs of observations) {
    if (obs.toolName === 'memory_search') continue
    toolTexts.push(normalizeForMatch([obs.title, ...obs.facts].join('\n')))
  }
  return { userTexts, toolTexts }
}

export interface CandidateParseResult {
  candidates: MemoryCandidate[]
  /** 单条非法被丢弃的数量（不整体失败） */
  droppedCount: number
}

/** LLM 响应以 unknown 接收并逐字段校验；整体非法返回 null，单条非法丢弃计数 */
export function parseMemoryCandidateResponse(
  raw: string,
  provenance: EvidenceProvenance
): CandidateParseResult | null {
  try {
    const trimmed = stripJsonFence(raw.trim())
    if (!trimmed) {
      return null
    }

    const parsed: unknown = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) {
      return null
    }

    const candidates: MemoryCandidate[] = []
    let droppedCount = 0
    for (const item of parsed) {
      const candidate = normalizeCandidate(item, provenance)
      if (candidate) {
        candidates.push(candidate)
      } else {
        droppedCount += 1
      }
    }
    return { candidates, droppedCount }
  } catch {
    return null
  }
}

function stripJsonFence(text: string): string {
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(text)
  if (fence) {
    return fence[1].trim()
  }
  return text
}

function normalizeCandidate(item: unknown, provenance: EvidenceProvenance): MemoryCandidate | null {
  if (typeof item !== 'object' || item === null) {
    return null
  }
  const obj = item as Record<string, unknown>

  const kind = readEnumValue(obj.kind, MEMORY_KINDS)
  if (kind === null) {
    return null
  }
  const scopeHint = readEnumValue(obj.scopeHint, SCOPE_HINTS)
  if (scopeHint === null) {
    return null
  }
  const explicitness = readEnumValue(obj.explicitness, EXPLICITNESS_LEVELS)
  if (explicitness === null) {
    return null
  }

  const key = normalizeKey(obj.key)
  if (key === undefined) {
    return null
  }
  const content = normalizeContent(obj.content)
  if (content === null) {
    return null
  }
  const confidence = clampConfidence(obj.confidence)
  if (confidence === null) {
    return null
  }
  const intent = normalizeIntent(obj.intent)
  if (intent === null) {
    return null
  }

  const evidence = normalizeEvidence(obj.evidence, provenance)
  if (evidence.length === 0) {
    return null
  }

  return { kind, scopeHint, memoryKey: key, content, explicitness, confidence, intent, evidence }
}

function readEnumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

/** null/缺省 → null；空串/空白 → null；非法类型 → undefined（整条丢弃） */
function normalizeKey(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim().toLowerCase().slice(0, MEMORY_KEY_MAX_CHARS)
  return normalized.length > 0 ? normalized : null
}

/** content 必须非空且过 PrivacyFilter；敏感命中整条丢弃 */
function normalizeContent(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const filtered = filterPrivacyText(value)
  if (filtered.shouldDiscard) {
    return null
  }
  const normalized = filtered.text.replace(/\s+/g, ' ').trim().slice(0, MEMORY_CANDIDATE_CONTENT_MAX_CHARS)
  return normalized.length > 0 ? normalized : null
}

function clampConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return Math.min(1, Math.max(0, value))
}

/** intent 缺省按 assert（候选基础模型无此字段）；出现非法值则整条丢弃 */
function normalizeIntent(value: unknown): MemoryCandidateIntent | null {
  if (value === undefined || value === null) {
    return 'assert'
  }
  return readEnumValue(value, MEMORY_CANDIDATE_INTENTS)
}

/** 逐条校验 evidence：枚举白名单 → 隐私过滤 → 溯源逐字命中 → 截断 */
function normalizeEvidence(
  value: unknown,
  provenance: EvidenceProvenance
): MemoryCandidateEvidence[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: MemoryCandidateEvidence[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const obj = item as Record<string, unknown>
    const type = readEnumValue(obj.type, MEMORY_EVIDENCE_TYPES)
    if (type === null || typeof obj.excerpt !== 'string' || obj.excerpt.trim().length === 0) {
      continue
    }

    const filtered = filterPrivacyText(obj.excerpt.trim())
    if (filtered.shouldDiscard || filtered.text.trim().length === 0) {
      continue
    }

    if (!matchesProvenance(type, filtered.text, provenance)) {
      continue
    }

    const evidence: MemoryCandidateEvidence = {
      type: type as MemoryEvidenceType,
      excerpt: filtered.text.slice(0, MEMORY_EVIDENCE_EXCERPT_MAX_CHARS).trim()
    }
    if (typeof obj.sessionId === 'string' && obj.sessionId.trim()) {
      evidence.sessionId = obj.sessionId.trim()
    }
    if (typeof obj.messageId === 'string' && obj.messageId.trim()) {
      evidence.messageId = obj.messageId.trim()
    }
    if (typeof obj.sourcePath === 'string' && obj.sourcePath.trim()) {
      evidence.sourcePath = obj.sourcePath.trim()
    }
    out.push(evidence)
  }
  return out
}

/** excerpt 必须逐字出现在同角色原文中；助手回复无法通过 user_message 溯源 */
function matchesProvenance(
  type: MemoryEvidenceType,
  excerpt: string,
  provenance: EvidenceProvenance
): boolean {
  const needle = normalizeForMatch(excerpt)
  if (!needle) {
    return false
  }
  const texts = type === 'user_message' ? provenance.userTexts : provenance.toolTexts
  return texts.some((text) => text.includes(needle))
}

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}
