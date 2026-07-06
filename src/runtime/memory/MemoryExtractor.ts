/**
 * MemoryExtractor — 工具轨迹/对话 → 结构化记忆字段（LLM 提炼）
 *
 * fail-soft：任何异常返回 null，不 throw，不影响主对话。
 */
import type { ChatMessage } from '../model/types'
import type { MemoryObservation } from './ObservationCapture'
import { buildExtractMessages } from './memoryPrompts'

/** 提炼产出的结构化记忆 */
export interface ExtractedMemory {
  /** 用户这一程在解决什么需求 */
  userNeed: string
  /** 用的什么办法 */
  approach: string
  /** 结果如何 */
  outcome: string
  /** 踩了什么坑（最关键的信号） */
  whatFailed: string
  /** 什么 work 了 */
  whatWorked: string
  /** 相关实体标签（本阶段不入图，仅存储） */
  tags: string[]
}

/**
 * 提炼模块依赖口子：当前包主 modelPool；未来可换副模型只改装配。
 */
export interface MemoryExtractorDeps {
  chat: (messages: ChatMessage[], opts?: { reasoningEffort?: 'low' }) => Promise<string>
}

/** 硬编码：覆盖主模型 thinking 强度 */
export const EXTRACT_REASONING_EFFORT = 'low' as const

export class MemoryExtractor {
  constructor(private readonly deps: MemoryExtractorDeps) {}

  /**
   * 把最近会话 + 工具轨迹提炼成结构化记忆。
   * 失败时返回 null（上层走强降级）。
   */
  async extract(input: {
    recentMessages: ChatMessage[]
    observations: readonly MemoryObservation[]
  }): Promise<ExtractedMemory[] | null> {
    try {
      if (input.recentMessages.length === 0 && input.observations.length === 0) {
        return null
      }

      const messages = buildExtractMessages(input)
      const raw = await this.deps.chat(messages, { reasoningEffort: EXTRACT_REASONING_EFFORT })
      return parseExtractedJson(raw)
    } catch {
      return null
    }
  }
}

/** 从 LLM 输出解析 JSON 数组；部分字段缺失的条目丢弃 */
export function parseExtractedJson(raw: string): ExtractedMemory[] | null {
  try {
    const trimmed = stripJsonFence(raw.trim())
    if (!trimmed) {
      return null
    }

    const parsed: unknown = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) {
      return null
    }

    const result: ExtractedMemory[] = []
    for (const item of parsed) {
      const entry = normalizeExtractedEntry(item)
      if (entry) {
        result.push(entry)
      }
    }

    return result.length > 0 ? result : null
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

function normalizeExtractedEntry(item: unknown): ExtractedMemory | null {
  if (!item || typeof item !== 'object') {
    return null
  }
  const obj = item as Record<string, unknown>

  const userNeed = asNonEmptyString(obj.userNeed)
  const approach = asNonEmptyString(obj.approach)
  const outcome = asNonEmptyString(obj.outcome)
  const whatFailed = asString(obj.whatFailed)
  const whatWorked = asString(obj.whatWorked)

  if (!userNeed || !approach || !outcome) {
    return null
  }

  const tags = normalizeTags(obj.tags)
  return { userNeed, approach, outcome, whatFailed, whatWorked, tags }
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const t = value.trim()
  return t.length > 0 ? t : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const out: string[] = []
  for (const tag of value) {
    if (typeof tag === 'string') {
      const t = tag.trim()
      if (t && !out.includes(t)) {
        out.push(t)
      }
    }
  }
  return out
}
