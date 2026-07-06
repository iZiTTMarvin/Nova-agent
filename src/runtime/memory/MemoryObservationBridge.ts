/**
 * EventBus → ObservationCapture 只读订阅（不干扰工具结果链）
 */
import type { AgentEvent } from '../agent/types'
import type { EventBus } from '../agent/EventBus'
import { getObservationCaptureForSession, type ObservationCapture } from './ObservationCapture'

/**
 * 订阅 tool_call / tool_result / message_end，将轨迹写入 working buffer。
 * memoryCaptureEnabled=false 时不应调用（零开销）。
 */
export function subscribeObservationCapture(
  eventBus: EventBus,
  sessionId: string,
  capture: ObservationCapture = getObservationCaptureForSession(sessionId)
): () => void {
  return eventBus.on((event: AgentEvent) => {
    switch (event.type) {
      case 'tool_call':
        capture.onToolCall({
          sessionId,
          messageId: event.messageId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args
        })
        break
      case 'tool_result':
        capture.onToolResult({
          sessionId,
          messageId: event.messageId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result
        })
        break
      case 'message_end':
        capture.onMessageEnd(sessionId)
        break
      default:
        break
    }
  })
}
