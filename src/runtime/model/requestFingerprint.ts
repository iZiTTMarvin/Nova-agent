/**
 * WireSnapshot — 最终请求体的语义指纹。
 *
 * 在 OpenAICompatibleModelClient.chat 内，经 sanitizeToolMessages → 视觉投影 →
 * toApiMessage → cache marker → 剥离 internal 之后计算。这个形态才是真正决定
 * 服务端前缀缓存命中的字节流。
 *
 * 全部字段只存哈希，不落明文。
 */
import { createHash } from 'crypto'
import { canonicalizeForCacheComparison } from './cacheCanonicalize'
import type { CacheProfile, CacheProfileId } from './cacheProfile'

/** 最终请求体的语义快照（仅哈希，无明文） */
export interface WireSnapshot {
  model: string
  /** 最终 tools 数组序列化哈希（不排序，顺序漂移可被检测） */
  toolsHash: string
  /** 每条消息整条哈希（经 provider 规范化后） */
  semanticMessageHashes: string[]
  /** 完整请求体精确哈希（排障用） */
  exactBodyHash: string
}

/**
 * 在最终请求体上计算 WireSnapshot。
 *
 * semantic 侧经 canonicalizeForCacheComparison 规范化：
 * - Anthropic 档案剥离滚动 cache_control marker（避免假前缀 diff）
 * - 其余档案保留影响前缀缓存的全部字段
 *
 * @param body 即将发给 provider 的最终 JSON 对象
 * @param profile 当前缓存档案（决定规范化策略）
 */
export function computeWireSnapshot(
  body: Record<string, unknown>,
  profile: CacheProfile | CacheProfileId
): WireSnapshot {
  const canonical = canonicalizeForCacheComparison(body, profile)
  const messages = (canonical.messages as Array<Record<string, unknown>> | undefined) ?? []
  const tools = (canonical.tools as Array<Record<string, unknown>> | undefined) ?? []

  return {
    model: typeof canonical.model === 'string' ? canonical.model : '',
    toolsHash: hashValue(tools),
    semanticMessageHashes: messages.map(m => hashValue(m)),
    exactBodyHash: hashValue(canonical)
  }
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}
