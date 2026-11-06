/**
 * 前缀缓存视角的请求体规范化。
 *
 * 服务端前缀缓存按逐字节匹配工作，但 Anthropic 消息上的滚动 cache_control
 * 会在相邻请求间移动，并改变单文本消息的形状，产生"假 diff"。
 * 本模块剥离消息 marker 并还原文本形状；工具锚点属于稳定前缀，必须保留。
 */
import type { CacheProfile, CacheProfileId } from './cacheProfile'
import { getCacheProfileCatalog } from './cacheProfile'

/**
 * 将最终请求体规范化为"前缀缓存视角"的形态。
 *
 * - Anthropic 档案：剥离消息中的滚动 cache_control marker，并还原单文本块形状。
 *   双缓冲每轮给最后 2 条非 system 消息打标记，上一轮倒数第 2 条
 *   本轮失去 marker，属正常行为而非语义变化；返回规范化深拷贝。
 *   工具定义上的稳定锚点必须保留：移动它会改写既有 tools 前缀字节。
 * - 其余档案：保留影响前缀缓存的全部字段，直接返回原引用（调用方只读）
 */
export function canonicalizeForCacheComparison(
  body: Record<string, unknown>,
  profile: CacheProfile | CacheProfileId
): Record<string, unknown> {
  const resolved: CacheProfile =
    typeof profile === 'string' ? getCacheProfileCatalog()[profile] : profile

  if (resolved.marker !== 'cache_control') return body

  const canonical = JSON.parse(JSON.stringify(body)) as Record<string, unknown>
  normalizeMessagesForCacheComparison(canonical)
  return canonical
}

/** 剥离滚动 marker，并还原 marker 注入造成的 string / 单文本块形状差异。 */
function normalizeMessagesForCacheComparison(body: Record<string, unknown>): void {
  const messages = body.messages
  if (!Array.isArray(messages)) return

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue
    const m = msg as Record<string, unknown>

    if ('cache_control' in m) {
      delete m.cache_control
    }

    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (typeof block === 'object' && block !== null && 'cache_control' in block) {
          delete (block as Record<string, unknown>).cache_control
        }
      }
      const block = m.content.length === 1 ? m.content[0] : null
      if (typeof block === 'object' && block !== null) {
        const candidate = block as Record<string, unknown>
        const keys = Object.keys(candidate)
        if (
          candidate.type === 'text' &&
          typeof candidate.text === 'string' &&
          keys.every(key => key === 'type' || key === 'text')
        ) {
          m.content = candidate.text
        }
      }
    }
  }
}
