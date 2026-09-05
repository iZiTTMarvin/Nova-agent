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
  /**
   * 规范化后请求体的哈希（16 hex；Anthropic 档案会剥离滚动 cache_control）。
   * 只用于前缀缓存比较，不是原始请求对账哈希。
   */
  exactBodyHash: string
  bodyBytes: number
  /**
   * 实际出站 JSON 字符串的完整 SHA-256（64 hex），与代理/供应商侧原始请求对账用。
   * 未提供原始请求体（含旧版持久化快照）时为空串，表示不可用，不得当作真实哈希。
   */
  rawBodyHash: string
  rawBodyBytes: number
}

/** 原始请求体哈希缺失时的占位；空串表示「未记录」，不是任何正文的哈希。 */
export const UNAVAILABLE_BODY_HASH = ''

/**
 * 在最终请求体上计算 WireSnapshot。
 *
 * semantic 侧经 canonicalizeForCacheComparison 规范化：
 * - Anthropic 档案剥离滚动 cache_control marker（避免假前缀 diff）
 * - 其余档案保留影响前缀缓存的全部字段
 *
 * rawBody 为实际写出的 JSON 字符串；提供时另算完整对账哈希，与规范化哈希分开保存。
 */
export function computeWireSnapshot(
  body: Record<string, unknown>,
  profile: CacheProfile | CacheProfileId,
  rawBody?: string
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
    bodyBytes: utf8Bytes(bodyJson),
    rawBodyHash: rawBody === undefined ? UNAVAILABLE_BODY_HASH : fullHash(rawBody),
    rawBodyBytes: rawBody === undefined ? 0 : utf8Bytes(rawBody)
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

/** 完整 SHA-256（64 hex），用于与外部原始请求记录对账 */
function fullHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
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

/** 把旧快照升到当前结构（分段哈希与原始请求体哈希未知，仅保留 whole） */
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
    bodyBytes: 0,
    rawBodyHash: UNAVAILABLE_BODY_HASH,
    rawBodyBytes: 0
  }
}
