import type { UserDeliveryFacts } from '../../shared/session/types'
import type { ChatMessage } from '../model/types'
import type { ImageContent } from '../../shared/tools/types'
import { stripLeakedToolMarkup } from '../../shared/tool-call-text-fallback'

/** 首发与恢复只使用当时记录的注入，不重算过去的环境。 */
export function projectUserContent(content: ChatMessage['content'], facts?: UserDeliveryFacts): ChatMessage['content'] {
  if (!facts) return content
  content = facts.skillInput?.userContent ?? content
  if (typeof content === 'string') {
    const suffix = facts.modeInstruction ? `${content}\n\n${facts.modeInstruction}` : content
    return facts.sessionPrefix ? `${facts.sessionPrefix}\n\n${suffix}` : suffix
  }
  return [
    ...(facts.sessionPrefix ? [{ type: 'text' as const, text: facts.sessionPrefix }] : []),
    ...content,
    ...(facts.modeInstruction ? [{ type: 'text' as const, text: facts.modeInstruction }] : [])
  ]
}

export function projectUserMessages(content: ChatMessage['content'], userMessageId?: string, facts?: UserDeliveryFacts): ChatMessage[] {
  const origin = (step: number) => userMessageId ? { origin: { messageId: userMessageId, step } } : {}
  const prelude: ChatMessage[] = facts?.skillInput ? [{
    role: 'assistant', content: facts.skillInput.assistantPrelude, inputPrelude: true, ...origin(0)
  }] : []
  return [...prelude, { role: 'user', content: projectUserContent(content, facts), ...origin(prelude.length) }]
}

/** 切尾部与压缩共用同一输入边界，不能留下无技能正文的任务提示。 */
export function alignToUserInputBoundary(messages: readonly ChatMessage[], index: number): number {
  return index > 0 && messages[index - 1]?.inputPrelude ? index - 1 : index
}

export function projectAssistantContent(content: ChatMessage['content']): ChatMessage['content'] {
  return typeof content === 'string' ? stripLeakedToolMarkup(content) : content.map(block =>
    block.type === 'text' ? { ...block, text: stripLeakedToolMarkup(block.text) } : block)
}

export function serializeToolArguments(args: Record<string, unknown>): string {
  return JSON.stringify(args)
}

export function toToolContent(resultText: string, resultImages?: ImageContent[]): ChatMessage['content'] {
  if (!resultImages?.length) return resultText
  return [
    { type: 'text', text: resultText },
    ...resultImages.map(img => ({ type: 'image_url' as const, image_url: { url: `data:${img.mimeType};base64,${img.data}` } }))
  ]
}
