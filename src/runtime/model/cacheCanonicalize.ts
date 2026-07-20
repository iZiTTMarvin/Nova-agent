/**
 * 前缀缓存视角的请求体规范化。
 *
 * 服务端前缀缓存按逐字节匹配工作，但部分 provider 的滚动标记机制
 * （如 Anthropic 的 cache_control 双缓冲）会在相邻请求间移动标记位置，
 * 产生"假 diff"。本模块将这些非语义变化剥离，使规范化后的请求体
 * 只反映真正影响前缀缓存的内容。
 */
import type { CacheProfile, CacheProfileId } from './cacheProfile'
import { getCacheProfileCatalog } from './cacheProfile'

/**
 * 将最终请求体规范化为"前缀缓存视角"的形态。
 *
 * - Anthropic 档案：剥离所有消息与工具定义中的 cache_control 字段
 *   （滚动双缓冲每轮给最后 2 条非 system 消息打标记，上一轮倒数第 2 条
 *   本轮失去 marker，属正常行为而非语义变化）
 * - 其余档案：保留影响前缀缓存的全部字段（reasoning_content、tool_calls、工具顺序）
 *
 * 不修改入参，返回深拷贝后的新对象。
 */
export function canonicalizeForCacheComparison(
  body: Record<string, unknown>,
  profile: CacheProfile | CacheProfileId
): Record<string, unknown> {
  const resolved: CacheProfile =
    typeof profile === 'string' ? getCacheProfileCatalog()[profile] : profile

  const canonical = JSON.parse(JSON.stringify(body)) as Record<string, unknown>

  if (resolved.marker === 'cache_control') {
    stripCacheControlFromMessages(canonical)
    stripCacheControlFromTools(canonical)
  }

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

/** 剥离工具定义数组中的 cache_control 字段 */
function stripCacheControlFromTools(body: Record<string, unknown>): void {
  const tools = body.tools
  if (!Array.isArray(tools)) return

  for (const tool of tools) {
    if (typeof tool === 'object' && tool !== null && 'cache_control' in tool) {
      delete (tool as Record<string, unknown>).cache_control
    }
  }
}
