/**
 * contextBuilder — 从 session 历史恢复模型可用的对话上下文
 *
 * 核心职责：把 SessionMessage[] 转换成 ChatMessage[]，让每次 send-message 时
 * 模型能看到之前所有 user / assistant / tool 历史，实现真正的多轮对话。
 *
 * 设计约束（缓存 Harness）：
 * - system prompt 由 AgentLoop 构造时注入（frozenSystemPrompt），此处不再处理
 * - thinking 内容不进入模型上下文
 * - assistant 的 toolCalls 恢复为结构化 tool_calls，result 拆成独立 tool 消息
 */
import type { ChatMessage, ContentBlock } from '../model/types'
import type { SessionData } from '../sessions/types'
import type { Mode } from '../../shared/session/types'

/**
 * 从会话数据构建模型对话上下文（不含 system prompt）
 *
 * system prompt 由 agentHandler 通过 AgentLoop 构造时注入（frozenSystemPrompt），
 * 此处只恢复 user / assistant / tool 历史消息，保证前缀稳定。
 */
export function buildConversationContext(
  session: SessionData,
  _mode: Mode
): ChatMessage[] {
  const context: ChatMessage[] = []

  for (const msg of session.messages) {
    // system 消息跳过：由 AgentLoop 构造时的 frozenSystemPrompt 提供
    if (msg.role === 'system') continue

    // 注：session context 不经此路径恢复。合并方案下它只在 sendMessage 运行时
    // 拼到 user content 前缀，不作为独立消息进 SessionStore。SessionMessage 类型
    // 本身也不携带 internal 字段，故此处无须过滤。

    // thinking 块不进入模型上下文：只恢复 content（纯正文）和 toolCalls
    if (msg.role === 'assistant') {
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: msg.content
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        assistantMsg.toolCalls = msg.toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments
        }))
      }

      context.push(assistantMsg)

      // 每个 toolCall 的 result 恢复为独立的 tool 消息
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (tc.result === undefined) {
            // S4 监测点：toolCall 缺失 result 是异常状态（正常路径 saveAssistantMessage
            // 都会写入 result）。这会导致 OpenAI 协议报 400（tool_calls 缺对应 tool message）。
            // 历史上 C1（压缩保留工具结果）的 bug 就表现为此处静默跳过——
            // 加 warning 让类似问题能在日志里第一时间被发现，而不是 API 报错后回查。
            console.warn(
              `[contextBuilder] assistant 消息 ${msg.id} 的 toolCall ${tc.id} (${tc.name}) 缺少 result，已跳过对应的 tool 消息。` +
              ` 可能原因：持久化时未写入（旧版本 bug）/ 压缩回调未合并 result（参考 C1）。`
            )
            continue
          }
          context.push({
            role: 'tool',
            content: tc.result,
            toolCallId: tc.id
          })
        }
      }

      continue
    }

    // tool 消息：session 中独立存在的 tool 消息（边缘情况）直接恢复
    if (msg.role === 'tool') {
      context.push({
        role: 'tool',
        content: msg.content,
        toolCallId: msg.toolCallId
      })
      continue
    }

    // user 消息：原样保留（content 可能是 string 或 ContentBlock[]）
    context.push({
      role: msg.role,
      content: msg.content as string | ContentBlock[]
    })
  }

  return context
}
