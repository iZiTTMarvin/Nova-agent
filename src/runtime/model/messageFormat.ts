/**
 * 消息格式适配器 — 缓存标记注入
 *
 * 根据 cacheStrategy 决定是否向消息和工具定义注入 cache_control 标记。
 * - auto：不做任何事（OpenAI/DeepSeek 等服务端自动缓存）
 * - anthropic：对最后 2 条消息 + 最后一个工具定义打 cache_control: { type: 'ephemeral' }
 *
 * 参考 openclacky 的双标记策略（2 markers）：
 * Turn N 标记 [-2] 和 [-1]；Turn N+1 时 [-2] 仍带标记 → 缓存 READ 命中。
 */
import type { CacheStrategy } from '../../shared/config/types'

/** 向 API 消息数组注入 cache_control 标记（返回新数组，不修改原数组） */
export function applyCacheMarkers(
  apiMessages: Record<string, unknown>[],
  strategy: CacheStrategy
): Record<string, unknown>[] {
  if (strategy !== 'anthropic' || apiMessages.length === 0) {
    return apiMessages
  }

  // 找到最后 2 条非 system 消息的索引
  const candidateIndices: number[] = []
  for (let i = apiMessages.length - 1; i >= 0 && candidateIndices.length < 2; i--) {
    const msg = apiMessages[i]
    if (msg.role === 'system') continue
    candidateIndices.push(i)
  }

  if (candidateIndices.length === 0) return apiMessages

  return apiMessages.map((msg, idx) => {
    if (!candidateIndices.includes(idx)) return msg
    return addCacheControlToMessage(msg)
  })
}

/** 向工具定义数组的最后一个工具注入 cache_control */
export function applyToolCacheMarker(
  apiTools: Record<string, unknown>[],
  strategy: CacheStrategy
): Record<string, unknown>[] {
  if (strategy !== 'anthropic' || apiTools.length === 0) {
    return apiTools
  }

  const result = apiTools.map(t => ({ ...t }))
  result[result.length - 1].cache_control = { type: 'ephemeral' }
  return result
}

function addCacheControlToMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const content = msg.content

  if (typeof content === 'string') {
    return {
      ...msg,
      content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
    }
  }

  if (Array.isArray(content)) {
    const newContent = content.map((block, idx) => {
      if (idx === content.length - 1 && typeof block === 'object' && block !== null) {
        return { ...(block as Record<string, unknown>), cache_control: { type: 'ephemeral' } }
      }
      return block
    })
    return { ...msg, content: newContent }
  }

  return msg
}
