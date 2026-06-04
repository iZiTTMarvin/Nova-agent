/**
 * 消息格式适配器 — 缓存标记注入
 *
 * 根据 cacheStrategy 决定是否向消息和工具定义注入 cache_control 标记。
 * - auto：不做任何事（OpenAI/DeepSeek 等服务端自动缓存）
 * - anthropic：对 system 消息 + 最后 2 条非 system 消息 + 最后一个工具定义
 *   打 cache_control: { type: 'ephemeral' }
 *
 * 标记点设计（参考 OpenClacky + Claude Code）：
 * - system 消息标记：系统提示约 350 tokens，整个会话逐字节不变，首轮写入后后续每轮命中
 * - 消息级双标记（openclacky 验证）：滚动双缓冲，Turn N 标记 [-2] 和 [-1]，
 *   Turn N+1 时 [-2] 仍带标记 → cache_read 命中
 * - 工具级标记最后一个：Anthropic 前缀匹配，最后一个工具标记覆盖所有前面的工具定义
 *
 * 总标记点 = 1(system) + 2(消息) + 1(工具) = 4，刚好在 Anthropic 的 4 断点限制内
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

  // 收集需要标记的位置：system 消息 + 最后 2 条非 system 消息
  const markerIndices = new Set<number>()

  // 标记最后一条 system 消息（系统提示稳定，首轮写入后每轮命中 cache_read）
  let systemIndex = -1
  for (let i = apiMessages.length - 1; i >= 0; i--) {
    const msg = apiMessages[i]
    if (msg.role === 'system') {
      systemIndex = i
      break
    }
  }
  if (systemIndex !== -1) {
    markerIndices.add(systemIndex)
  }

  // 标记最后 2 条非 system 消息（滚动双缓冲策略，参考 OpenClacky）
  let count = 0
  for (let i = apiMessages.length - 1; i >= 0 && count < 2; i--) {
    const msg = apiMessages[i]
    if (msg.role === 'system') continue
    // 跳过内部消息（如压缩指令），不标记缓存
    if (msg.internal === true) continue
    markerIndices.add(i)
    count++
  }

  if (markerIndices.size === 0) return apiMessages

  return apiMessages.map((msg, idx) => {
    if (!markerIndices.has(idx)) return msg
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
