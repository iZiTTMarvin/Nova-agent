/**
 * contextBuilder — 从 session 历史恢复模型可用的对话上下文
 *
 * 核心职责：把 SessionMessage[] 转换成 ChatMessage[]，让每次 send-message 时
 * 模型能看到之前所有 user / assistant / tool 历史，实现真正的多轮对话。
 *
 * 设计约束（缓存 Harness）：
 * - system prompt 由 AgentLoop 构造时注入（frozenSystemPrompt），此处不再处理
 * - 有 blocks 时一律按子轮边界拆分（与运行时路径对齐）；无 blocks 的旧会话回退扁平路径
 * - reasoning 附着受 reasoningReplay 白名单 + 来源兼容性门控（跨 provider thinking 不回传）
 * - image_url 的持久化引用（如 nova-image://）经 resolveImageUrl 回调转回模型可识别的 URL；
 *   本函数保持纯函数无 IO 依赖，转换实现由调用方注入
 */
import type { ChatMessage, ContentBlock } from '../../model/types'
import type { CacheProfile } from '../../model/cacheProfile'
import { isReasoningSourceCompatible } from '../../model/reasoningSource'
import type { SessionData, SessionMessage, SessionToolCall } from '../../sessions/types'
import { getSessionActiveMessages } from '../../sessions/tree'
import type { Mode, MessageBlock } from '../../../shared/session/types'
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

/** buildConversationContext 可选参数（与旧版 resolveImageUrl 第三参兼容） */
export interface BuildConversationContextOptions {
  resolveImageUrl?: (url: string) => string
  /**
   * 来自 CacheProfile.reasoningReplay。
   * - 'none' / 缺省：走扁平恢复（与改造前一致）
   * - 'tool-call-history' | 'all-history'：按 blocks 拆子轮并恢复 reasoningContent
   */
  reasoningReplay?: CacheProfile['reasoningReplay']
  /**
   * 当前活跃档案 ID；用于过滤跨档案 reasoning。
   * 缺省时不做来源门控（仅按 reasoningReplay 档位）。
   */
  currentProviderId?: string
}

function normalizeBuildOptions(
  resolveImageUrlOrOpts?: ((url: string) => string) | BuildConversationContextOptions
): BuildConversationContextOptions {
  if (typeof resolveImageUrlOrOpts === 'function') {
    return { resolveImageUrl: resolveImageUrlOrOpts }
  }
  return resolveImageUrlOrOpts ?? {}
}

/**
 * 默认扁平路径：单条 assistant（全部 toolCalls）+ 多条 tool 消息；丢弃 thinking。
 * 供 reasoningReplay === 'none' 的档案使用。
 */
function projectAssistantFlattened(msg: SessionMessage): ChatMessage[] {
  const out: ChatMessage[] = []
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

  out.push(assistantMsg)

  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      if (tc.result === undefined) {
        console.warn(
          `[contextBuilder] assistant 消息 ${msg.id} 的 toolCall ${tc.id} (${tc.name}) 缺少 result，已跳过对应的 tool 消息。` +
            ` 可能原因：持久化时未写入（旧版本 bug）/ 压缩回调未合并 result（参考 C1）。`
        )
        continue
      }
      out.push({
        role: 'tool',
        content: tc.result,
        toolCallId: tc.id,
        ...(tc.artifactId ? { artifactId: tc.artifactId } : {}),
        ...(tc.truncationMeta ? { truncationMeta: tc.truncationMeta } : {})
      })
    }
  }

  return out
}

/**
 * reasoningReplay ≠ none：按 blocks 边界重建「assistant → tool results」子轮序列。
 *
 * 边界规则：已收集 tool 后再遇到 thinking/text → 先 flush 上一子轮。
 * 连续 tool 块视为同一子轮的并行调用。
 *
 * reasoning 策略：
 * - tool-call-history（deepseek）：仅含 toolCalls 的 assistant 携带 reasoningContent
 * - all-history（kimi / glm）：凡有 thinking 的 assistant 均携带
 * - 来源门控：仅累加与 currentProviderId 兼容的 thinking（无 providerId 旧块视为兼容）
 */
export function projectAssistantWithReasoningReplay(
  msg: SessionMessage,
  reasoningReplay: 'none' | 'tool-call-history' | 'all-history',
  currentProviderId?: string
): ChatMessage[] {
  const blocks = msg.blocks
  if (!blocks || blocks.length === 0) {
    return projectAssistantFlattened(msg)
  }

  const toolCallById = new Map((msg.toolCalls ?? []).map(tc => [tc.id, tc]))
  const out: ChatMessage[] = []

  let reasoning = ''
  let reasoningProviderId: string | undefined
  let text = ''
  let pendingTools: Array<{
    block: Extract<MessageBlock, { type: 'tool' }>
    tc: SessionToolCall | undefined
  }> = []

  const attachReasoning = (assistant: ChatMessage, hasToolCalls: boolean): void => {
    // reasoningReplay === 'none'：仍拆子轮，但不附着 reasoning
    if (!reasoning || reasoningReplay === 'none') return
    if (reasoningReplay === 'all-history' || hasToolCalls) {
      assistant.reasoningContent = reasoning
      if (reasoningProviderId) assistant.reasoningProviderId = reasoningProviderId
    }
  }

  const flushToolSubTurn = (): void => {
    const assistant: ChatMessage = {
      role: 'assistant',
      content: sanitizeAssistantContent(text)
    }
    attachReasoning(assistant, true)
    assistant.toolCalls = pendingTools.map(({ block, tc }) => ({
      id: block.toolCallId,
      name: block.toolName,
      arguments: tc?.arguments ?? JSON.stringify(block.arguments ?? {})
    }))
    out.push(assistant)

    for (const { block, tc } of pendingTools) {
      const result = block.result ?? tc?.result
      if (result === undefined) {
        console.warn(
          `[contextBuilder] assistant 消息 ${msg.id} 的 toolCall ${block.toolCallId} (${block.toolName}) 缺少 result，已跳过对应的 tool 消息。`
        )
        continue
      }
      out.push({
        role: 'tool',
        content: result,
        toolCallId: block.toolCallId,
        ...(tc?.artifactId ? { artifactId: tc.artifactId } : {}),
        ...(tc?.truncationMeta ? { truncationMeta: tc.truncationMeta } : {})
      })
    }

    reasoning = ''
    reasoningProviderId = undefined
    text = ''
    pendingTools = []
  }

  const flushFinalAssistant = (): void => {
    if (!text && !reasoning) return
    const assistant: ChatMessage = {
      role: 'assistant',
      content: sanitizeAssistantContent(text)
    }
    attachReasoning(assistant, false)
    out.push(assistant)
    reasoning = ''
    reasoningProviderId = undefined
    text = ''
  }

  for (const block of blocks) {
    if (block.type === 'thinking') {
      if (pendingTools.length > 0) flushToolSubTurn()
      // 跨档案 thinking 保留在存档，但不进入模型回传
      if (
        currentProviderId &&
        !isReasoningSourceCompatible(block.providerId, currentProviderId)
      ) {
        continue
      }
      reasoning += block.content
      if (block.providerId && !reasoningProviderId) {
        reasoningProviderId = block.providerId
      }
    } else if (block.type === 'text') {
      if (pendingTools.length > 0) flushToolSubTurn()
      text += block.content
    } else if (block.type === 'tool') {
      pendingTools.push({ block, tc: toolCallById.get(block.toolCallId) })
    }
    // image 块不进入模型侧 assistant 投影
  }

  if (pendingTools.length > 0) flushToolSubTurn()
  flushFinalAssistant()

  // 极端兜底：blocks 无法产出任何消息时回退扁平路径
  return out.length > 0 ? out : projectAssistantFlattened(msg)
}

/**
 * 从会话数据构建模型对话上下文（不含 system prompt）
 *
 * system prompt 由 agentHandler 通过 AgentLoop 构造时注入（frozenSystemPrompt），
 * 此处只恢复 user / assistant / tool 历史消息，保证前缀稳定。
 *
 * @param resolveImageUrlOrOpts 可选：图片 URL 转换器，或含 resolveImageUrl / reasoningReplay 的选项对象。
 *   传入函数时行为与改造前完全一致（扁平恢复）。
 */
export function buildConversationContext(
  session: SessionData,
  _mode: Mode,
  resolveImageUrlOrOpts?: ((url: string) => string) | BuildConversationContextOptions
): ChatMessage[] {
  const opts = normalizeBuildOptions(resolveImageUrlOrOpts)
  const { resolveImageUrl, reasoningReplay, currentProviderId } = opts
  const replayMode: 'none' | 'tool-call-history' | 'all-history' =
    reasoningReplay === 'tool-call-history' || reasoningReplay === 'all-history'
      ? reasoningReplay
      : 'none'

  const context: ChatMessage[] = []
  const activeMessages = getSessionActiveMessages(session)

  for (const msg of activeMessages) {
    // system 消息跳过：由 AgentLoop 构造时的 frozenSystemPrompt 提供
    if (msg.role === 'system') continue

    if (msg.role === 'assistant') {
      // 有 blocks 时一律按子轮拆分（与运行时路径对齐）；reasoning 附着仍受 replay + 来源门控
      if (msg.blocks && msg.blocks.length > 0) {
        context.push(
          ...projectAssistantWithReasoningReplay(msg, replayMode, currentProviderId)
        )
      } else {
        context.push(...projectAssistantFlattened(msg))
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
    const userContent = msg.content as string | ContentBlock[]
    context.push({
      role: msg.role,
      content: resolveImageUrl ? resolveImageUrlsInContent(userContent, resolveImageUrl) : userContent
    })
  }

  return context
}
