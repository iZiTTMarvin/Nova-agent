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
      // 子代理活动行的实时进度：首个事件到来前渲染层只能显示兜底文案
      runCoordinator.heartbeat(runId, { label: '正在思考…' })
      break
    case 'tool_call': {
      // 嵌套调用（run_code 沙箱内）不是模型发出的独立工具调用：
      // 不记录 run 工具相位，仅作观测事件转发，避免污染 run 状态
      if (event.parentToolCallId) break
      const idempotent = isIdempotentToolName(event.toolName)
      runCoordinator.heartbeat(runId, { label: `调用 ${event.toolName}` })
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
      if (event.parentToolCallId) break
      const isError = event.failed ?? isToolFailureText(event.result)
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
        label: event.interrupted ? 'interrupted' : '完成一轮回复'
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
