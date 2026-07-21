/**
 * WireSnapshot — 最终请求体的语义指纹。
 *
 * 在 OpenAICompatibleModelClient.chat 内，经 sanitizeToolMessages → 视觉投影 →
 * toApiMessage → cache marker → 剥离 internal 之后计算。这个形态才是真正决定
 * 服务端前缀缓存命中的字节流。
 *
 * 全部指纹字段只存哈希；另存字节量级供作废估算，不落明文。
 */
import { createHash } from 'crypto'
import { canonicalizeForCacheComparison } from './cacheCanonicalize'
import type { CacheProfile, CacheProfileId } from './cacheProfile'

/** 单条消息的分段指纹（whole 用于快路径，分段用于 firstDiffPart） */
export interface MessageSegmentFingerprint {
  whole: string
  role: string
  content: string
  reasoningContent: string
  toolCalls: string
  toolResult: string
  /** JSON 序列化后的 UTF-8 字节数 */
  bytes: number
}

/** 最终请求体的语义快照（仅哈希 + 量级，无明文） */
export interface WireSnapshot {
  model: string
  toolsHash: string
  toolsBytes: number
  messages: MessageSegmentFingerprint[]
  exactBodyHash: string
  bodyBytes: number
}

/**
 * 在最终请求体上计算 WireSnapshot。
 *
 * semantic 侧经 canonicalizeForCacheComparison 规范化：
 * - Anthropic 档案剥离滚动 cache_control marker（避免假前缀 diff）
 * - 其余档案保留影响前缀缓存的全部字段
 */
export function computeWireSnapshot(
  body: Record<string, unknown>,
  profile: CacheProfile | CacheProfileId
): WireSnapshot {
  const canonical = canonicalizeForCacheComparison(body, profile)
  const messages = (canonical.messages as Array<Record<string, unknown>> | undefined) ?? []
  const tools = (canonical.tools as Array<Record<string, unknown>> | undefined) ?? []
  const toolsJson = JSON.stringify(tools)
  const bodyJson = JSON.stringify(canonical)

  return {
    model: typeof canonical.model === 'string' ? canonical.model : '',
    toolsHash: hashString(toolsJson),
    toolsBytes: utf8Bytes(toolsJson),
    messages: messages.map(fingerprintMessage),
    exactBodyHash: hashString(bodyJson),
    bodyBytes: utf8Bytes(bodyJson)
  }
}

function fingerprintMessage(msg: Record<string, unknown>): MessageSegmentFingerprint {
  const role = typeof msg.role === 'string' ? msg.role : ''
  const content = msg.content ?? ''
  const reasoningContent = msg.reasoning_content ?? ''
  const toolCalls = msg.tool_calls ?? null
  const toolResult =
    role === 'tool' ? (msg.content ?? '') : (msg.tool_call_id ?? '')
  const wholeJson = JSON.stringify(msg)

  return {
    whole: hashString(wholeJson),
    role: hashValue(role),
    content: hashValue(content),
    reasoningContent: hashValue(reasoningContent),
    toolCalls: hashValue(toolCalls),
    toolResult: hashValue(toolResult),
    bytes: utf8Bytes(wholeJson)
  }
}

function hashValue(value: unknown): string {
  return hashString(JSON.stringify(value))
}

function hashString(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** 旧版持久化快照（仅 whole 哈希数组）——读回时识别后当作无分段信息 */
export function isLegacyWireSnapshot(value: unknown): value is {
  model: string
  toolsHash: string
  semanticMessageHashes: string[]
  exactBodyHash: string
} {
  return (
    !!value &&
    typeof value === 'object' &&
    Array.isArray((value as { semanticMessageHashes?: unknown }).semanticMessageHashes)
  )
}

/** 把旧快照升到当前结构（分段哈希未知，仅保留 whole） */
export function upgradeLegacyWireSnapshot(legacy: {
  model: string
  toolsHash: string
  semanticMessageHashes: string[]
  exactBodyHash: string
}): WireSnapshot {
  return {
    model: legacy.model,
    toolsHash: legacy.toolsHash,
    toolsBytes: 0,
    messages: legacy.semanticMessageHashes.map(whole => ({
      whole,
      role: '',
      content: '',
      reasoningContent: '',
      toolCalls: '',
      toolResult: '',
      bytes: 0
    })),
    exactBodyHash: legacy.exactBodyHash,
    bodyBytes: 0
  }
}
