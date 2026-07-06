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
import type { ChatMessage } from './types'
import { extractTextFromContent } from './types'

/**
 * 规整工具调用消息，强制满足 OpenAI 严格协议的配对不变量。
 *
 * 背景：context.messages 是与方言无关的共享历史，可能被多条路径写入孤立消息：
 * 工具批次中途 abort/cancel 残留带 tool_calls 却无响应的 assistant、压缩边界、
 * 跨 provider/跨方言切换（如 Ollama native → DeepSeek）等。Ollama 等宽松后端能容忍，
 * 但 OpenAI 兼容的严格后端（DeepSeek）会直接报 400：
 *   - "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"（孤立 tool）
 *   - assistant 带 tool_calls 却缺少对应 tool 响应
 *
 * 因此在发送边界（仅 OpenAI 兼容客户端知道自己走严格协议）做一次规整，是适配器的职责，
 * 而非临时补丁。规整后保证：
 *   I1：每个 role:'tool' 必须存在“出现在它之前、且声明了同一 toolCallId”的 assistant.tool_calls，
 *       否则视为孤立消息丢弃。
 *   I2：assistant.tool_calls 中无对应 tool 响应的项被剥离；若整条 assistant 的 tool_calls 全被剥离
 *       且正文为空，则整条丢弃（该轮工具调用从未完成，保留无意义且会触发 400）。
 *
 * 返回新数组，不修改入参。
 */
export function sanitizeToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const n = messages.length

  // 顺序敏感地收集：截止某位置“之前”已被某个 assistant 声明过的 toolCallId。
  // 用它判定 tool 消息是否合法（必须出现在声明之后）。
  const declaredSoFar = new Set<string>()
  // 合法 tool 消息的下标
  const validToolIdx = new Set<number>()
  // 真正“有响应”的 toolCallId，用于反向校验 assistant.tool_calls 是否完整
  const respondedIds = new Set<string>()

  for (let i = 0; i < n; i++) {
    const m = messages[i]
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) declaredSoFar.add(tc.id)
    }
    if (m.role === 'tool') {
      if (m.toolCallId && declaredSoFar.has(m.toolCallId)) {
        validToolIdx.add(i)
        respondedIds.add(m.toolCallId)
      }
      // 否则：孤立 tool（前面没有声明它的 assistant），后续构建阶段丢弃
    }
  }

  const result: ChatMessage[] = []
  for (let i = 0; i < n; i++) {
    const m = messages[i]

    if (m.role === 'tool') {
      if (validToolIdx.has(i)) result.push(m)
      continue
    }

    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const kept = m.toolCalls.filter(tc => respondedIds.has(tc.id))
      if (kept.length === m.toolCalls.length) {
        result.push(m)
      } else if (kept.length > 0) {
        // 部分 tool_call 缺响应：剥离缺失项，保留有响应的配对
        result.push({ ...m, toolCalls: kept })
      } else {
        // 全部缺响应（典型：工具批次未执行就被取消）。剥离 tool_calls 退化为普通文本；
        // 若正文也为空则整条丢弃，避免产生空 assistant 又破坏配对。
        const hasText = extractTextFromContent(m.content).trim().length > 0
        if (hasText) {
          const { toolCalls: _drop, ...rest } = m
          result.push(rest)
        }
      }
      continue
    }

    result.push(m)
  }

  return result
}

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
    // 跳过内部消息（如压缩指令）与每轮变化的尾部注入（如记忆 L2），不标记缓存
    if (msg.internal === true) continue
    if (msg.skipCacheMarker === true) continue
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
