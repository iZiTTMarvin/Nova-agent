import type { AgentEvent } from '../types'
import type { RunCoordinator } from '../../run/RunCoordinator'
import { writerLeaseRegistry } from '../../workspace'
import { isToolFailureText } from '../../../shared/toolResultStatus'

export interface AgentEventRunProjectionContext {
  readonly runCoordinator: RunCoordinator
  readonly runId: string
  readonly resourceOwnerRunId: string
  readonly sessionId: string
}

/** 将普通 AgentEvent 投影到既有 Run/Interaction Owner，不复制运行状态。 */
export function projectAgentEventToRun(
  context: AgentEventRunProjectionContext,
  event: AgentEvent
): void {
  const { runCoordinator, runId, resourceOwnerRunId, sessionId } = context
  switch (event.type) {
    case 'message_start':
      runCoordinator.setMessageId(runId, event.messageId)
      if (!runCoordinator.getSnapshot(runId)?.turnStartedAt) {
        runCoordinator.markRunning(runId, event.messageId)
      }
      break
    case 'tool_call': {
      const idempotent = isIdempotentToolName(event.toolName)
      runCoordinator.recordToolPhase(
        runId,
        event.toolCallId,
        event.toolName,
        'prepared',
        { idempotent }
      )
      runCoordinator.recordToolPhase(
        runId,
        event.toolCallId,
        event.toolName,
        'executing',
        { idempotent }
      )
      break
    }
    case 'tool_result': {
      const isError = isToolFailureText(event.result)
      runCoordinator.recordToolPhase(
        runId,
        event.toolCallId,
        event.toolName,
        isError ? 'failed' : 'committed',
        { idempotent: isIdempotentToolName(event.toolName) }
      )
      break
    }
    case 'permission_request':
      runCoordinator.inbox.enqueue({
        runId,
        sessionId,
        messageId: event.messageId,
        type: 'permission',
        interactionId: event.requestId,
        payload: {
          requestId: event.requestId,
          toolName: event.toolName,
          args: event.args,
          riskLevel: event.riskLevel,
          reason: event.reason,
          commands: event.commands,
          toolCallIds: event.toolCallIds
        }
      })
      writerLeaseRegistry.release(resourceOwnerRunId)
      break
    case 'ask_question_request':
      writerLeaseRegistry.release(resourceOwnerRunId)
      break
    case 'message_end':
      runCoordinator.heartbeat(runId, {
        label: event.interrupted ? 'interrupted' : 'message_end'
      })
      break
    default:
      break
  }
}

function isIdempotentToolName(toolName: string): boolean {
  return new Set([
    'read',
    'ls',
    'grep',
    'find',
    'webSearch',
    'memorySearch',
    'askQuestion'
  ]).has(toolName)
}
