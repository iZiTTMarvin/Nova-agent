import type { AssistantCompletionPolicy } from './core/loopTypes'

export const ASSISTANT_CONTINUATION_INSTRUCTION =
  '[Runtime] The task has not produced a final response or tool action. Continue working on the same task. Use tools to inspect, implement, and verify the solution; only finish after the work is complete.'

/** 与无界面运行共用的指令文案。 */
export const HEADLESS_CONTINUATION_INSTRUCTION = ASSISTANT_CONTINUATION_INSTRUCTION

/**
 * 无工具时的续做策略：length/max_tokens 仍补全；
 * stop 且仅有思考、无正文时最多续做一次。
 */
export function createAssistantCompletionPolicy(): AssistantCompletionPolicy {
  let boundMessageId: string | null = null
  let reasoningContinuations = 0

  return ({ messageId, assistantContent, reasoningContent, finishReason }) => {
    if (boundMessageId !== messageId) {
      boundMessageId = messageId
      reasoningContinuations = 0
    }

    const hasFinalText = assistantContent.trim().length > 0
    const hasReasoning = Boolean(reasoningContent?.trim())
    const outputExhausted = finishReason === 'length' || finishReason === 'max_tokens'

    if (outputExhausted) {
      return { instruction: ASSISTANT_CONTINUATION_INSTRUCTION }
    }
    if (finishReason === 'stop' && !hasFinalText && hasReasoning) {
      if (reasoningContinuations >= 1) return undefined
      reasoningContinuations += 1
      return { instruction: ASSISTANT_CONTINUATION_INSTRUCTION }
    }
    return undefined
  }
}
