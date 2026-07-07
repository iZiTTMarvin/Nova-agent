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
 * - image_url 的持久化引用（如 nova-image://）经 resolveImageUrl 回调转回模型可识别的 URL（base64 data URL）；
 *   本函数保持纯函数无 IO 依赖，转换实现由调用方注入
 */
import type { ChatMessage, ContentBlock } from '../../model/types'
import type { SessionData } from '../../sessions/types'
import { getSessionActiveMessages } from '../../sessions/tree'
import type { Mode } from '../../../shared/session/types'
import { stripLeakedToolMarkup } from '../../../shared/tool-call-text-fallback'

/** 判断是否为需要转换的内部图片协议 URL（nova-image://） */
function isInternalImageUrl(url: string): boolean {
  return typeof url === 'string' && url.startsWith('nova-image://')
}

/**
 * 对 content（string 或 ContentBlock[]）中的 image_url 块应用 URL 转换。
 * 非 image_url 块与纯文本 content 原样返回。
 */
function resolveImageUrlsInContent(
  content: string | ContentBlock[],
  resolveImageUrl: (url: string) => string
): string | ContentBlock[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content

  let changed = false
  const next = content.map(block => {
    if (block.type === 'image_url' && isInternalImageUrl(block.image_url.url)) {
      changed = true
      return {
        ...block,
        image_url: { ...block.image_url, url: resolveImageUrl(block.image_url.url) }
      }
    }
    return block
  })
  return changed ? next : content
}

/**
 * 对一组 ChatMessage 扫描并转换其中的内部图片 URL。
 * 用于压缩快照（recentMessages）恢复路径——快照持久化时存的也是 nova-image:// URL。
 */
export function resolveImageUrlsInMessages(
  messages: ChatMessage[],
  resolveImageUrl: (url: string) => string
): ChatMessage[] {
  let changed = false
  const next = messages.map(msg => {
    const resolved = resolveImageUrlsInContent(msg.content, resolveImageUrl)
    if (resolved !== msg.content) {
      changed = true
      return { ...msg, content: resolved }
    }
    return msg
  })
  return changed ? next : messages
}

/** 清洗 assistant 正文中泄漏的模型原生工具标记（如 DeepSeek DSML） */
function sanitizeAssistantContent(content: string | ContentBlock[]): string | ContentBlock[] {
  if (typeof content === 'string') {
    return stripLeakedToolMarkup(content)
  }
  if (Array.isArray(content)) {
    return content.map(block => {
      if (block.type === 'text' && typeof block.text === 'string') {
        return { ...block, text: stripLeakedToolMarkup(block.text) }
      }
      return block
    })
  }
  return content
}

/**
 * 从会话数据构建模型对话上下文（不含 system prompt）
 *
 * system prompt 由 agentHandler 通过 AgentLoop 构造时注入（frozenSystemPrompt），
 * 此处只恢复 user / assistant / tool 历史消息，保证前缀稳定。
 *
 * @param resolveImageUrl 可选的图片 URL 转换器：把持久化的内部协议 URL（nova-image://）
 *   转回模型可识别的 base64 data URL。未传入时 image_url 原样透传（单测路径）。
 */
export function buildConversationContext(
  session: SessionData,
  _mode: Mode,
  resolveImageUrl?: (url: string) => string
): ChatMessage[] {
  const context: ChatMessage[] = []

  const activeMessages = getSessionActiveMessages(session)

  for (const msg of activeMessages) {
    // system 消息跳过：由 AgentLoop 构造时的 frozenSystemPrompt 提供
    if (msg.role === 'system') continue

    // 注：session context 不经此路径恢复。合并方案下它只在 sendMessage 运行时
    // 拼到 user content 前缀，不作为独立消息进 SessionStore。SessionMessage 类型
    // 本身也不携带 internal 字段，故此处无须过滤。

    // thinking 块不进入模型上下文：只恢复 content（纯正文）和 toolCalls
    if (msg.role === 'assistant') {
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: sanitizeAssistantContent(msg.content as string | ContentBlock[])
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
            toolCallId: tc.id,
            ...(tc.artifactId ? { artifactId: tc.artifactId } : {}),
            ...(tc.truncationMeta ? { truncationMeta: tc.truncationMeta } : {})
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

    // user 消息：原样保留（content 可能是 string 或 ContentBlock[]）。
    // 若含内部图片协议 URL（nova-image://），经 resolveImageUrl 转回 base64 data URL 供模型识别。
    const userContent = msg.content as string | ContentBlock[]
    context.push({
      role: msg.role,
      content: resolveImageUrl ? resolveImageUrlsInContent(userContent, resolveImageUrl) : userContent
    })
  }

  return context
}
