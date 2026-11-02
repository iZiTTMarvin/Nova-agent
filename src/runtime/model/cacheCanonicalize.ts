/**
 * 前缀缓存视角的请求体规范化。
 *
 * 服务端前缀缓存按逐字节匹配工作，但 Anthropic 消息上的滚动 cache_control
 * 会在相邻请求间移动，产生"假 diff"。本模块只剥离消息 marker；
 * 工具锚点属于稳定前缀，必须保留才能发现 marker 移动。
 */
import type { CacheProfile, CacheProfileId } from './cacheProfile'
import { getCacheProfileCatalog } from './cacheProfile'

/**
 * 将最终请求体规范化为"前缀缓存视角"的形态。
 *
 * - Anthropic 档案：剥离消息中的滚动 cache_control marker
 *   （双缓冲每轮给最后 2 条非 system 消息打标记，上一轮倒数第 2 条
 *   本轮失去 marker，属正常行为而非语义变化），返回剥离后的深拷贝。
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
  stripCacheControlFromMessages(canonical)
  return canonical
}

/** 剥离消息数组中所有 cache_control 字段（含 content blocks 内嵌的） */
function stripCacheControlFromMessages(body: Record<string, unknown>): void {
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
    }
  }
}
