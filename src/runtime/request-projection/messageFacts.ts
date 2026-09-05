import type { UserDeliveryFacts } from '../../shared/session/types'
import type { ChatMessage } from '../model/types'
import { stripLeakedToolMarkup } from '../../shared/tool-call-text-fallback'

/** 首发与恢复只使用当时记录的注入，不重算过去的环境。 */
export function projectUserContent(content: ChatMessage['content'], facts?: UserDeliveryFacts): ChatMessage['content'] {
  if (!facts) return content
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

export function projectAssistantContent(content: ChatMessage['content']): ChatMessage['content'] {
  return typeof content === 'string' ? stripLeakedToolMarkup(content) : content.map(block =>
    block.type === 'text' ? { ...block, text: stripLeakedToolMarkup(block.text) } : block)
}

export function serializeToolArguments(args: Record<string, unknown>): string {
  return JSON.stringify(args)
}
