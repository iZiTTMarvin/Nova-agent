import type { AssistantCompletionPolicy } from '../runtime/agent/core/loopTypes'

export const HEADLESS_CONTINUATION_INSTRUCTION =
  '[Runtime] The task has not produced a final response or tool action. Continue working on the same task. Use tools to inspect, implement, and verify the solution; only finish after the work is complete.'

export const headlessAssistantCompletionPolicy: AssistantCompletionPolicy = ({
  assistantContent,
  reasoningContent,
  finishReason
}) => {
  const hasFinalText = assistantContent.trim().length > 0
  const hasReasoning = Boolean(reasoningContent?.trim())
  const outputExhausted = finishReason === 'length' || finishReason === 'max_tokens'

  if (outputExhausted || (finishReason === 'stop' && !hasFinalText && hasReasoning)) {
    return { instruction: HEADLESS_CONTINUATION_INSTRUCTION }
  }
  return undefined
}
