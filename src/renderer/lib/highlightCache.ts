/**
 * highlightCache — highlightLine 结果的 LRU 缓存
 *
 * T13：同一行文本+文件路径的高亮结果可以复用。
 * 利用 Map 的插入顺序特性实现真 LRU：get 命中时先删后写，
 * 将热点条目提升到最新位置，确保只有最久未访问的条目才会被淘汰。
 *
 * key 为 filePath\0text 字符串，碰撞概率为零（比 djb2 32-bit hash 可靠）。
 * 上限 2000 条，控制 key 本身的内存占用（2000 × ~50B ≈ 100KB）。
 */
import type { DiffToken } from '../features/diff/syntaxHighlight'

const MAX_CACHE_SIZE = 2_000

const cache = new Map<string, DiffToken[]>()

/** 带缓存的高亮查询。命中时 promote 到最新位置后返回；未命中时计算并缓存 */
export function highlightLineCached(
  text: string,
  filePath: string,
  computeFn: (text: string, filePath: string) => DiffToken[]
): DiffToken[] {
  const key = `${filePath}\0${text}`
  const cached = cache.get(key)
  if (cached !== undefined) {
    // 真 LRU：先删后写，把热点条目移到 Map 末尾（最新位置）
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }

  const result = computeFn(text, filePath)

  // 淘汰 Map 最早的条目（最久未访问）
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value!
    cache.delete(firstKey)
  }

  cache.set(key, result)
  return result
}

/** 清空缓存（测试用） */
export function clearHighlightCache(): void {
  cache.clear()
}
