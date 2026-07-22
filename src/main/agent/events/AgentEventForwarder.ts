import type { BrowserWindow } from 'electron'
import type { AgentEvent, RecoveryState } from '../../../runtime/agent'
import type { RendererRecoveryState } from '../../../shared/ipc/types'
import {
  flushMainDeltaCoalescer,
  pushMainTextDelta,
  pushMainThinkingDelta
} from './mainDeltaCoalescer'

/** 截断 recovering.snapshot，只向渲染端发送 UI 所需字段 */
function toRendererRecoveryState(state: RecoveryState): RendererRecoveryState {
  switch (state.kind) {
    case 'continuing':
      return { kind: 'continuing' }
    case 'retrying':
      return {
        kind: 'retrying',
        attempt: state.attempt,
        lastError: state.lastError,
        maxAttempts: state.maxAttempts
      }
    case 'recovering':
      return { kind: 'recovering', fromMessageId: state.fromMessageId }
    case 'failed':
      return { kind: 'failed', error: state.error }
  }
}

/** 将 AgentEvent 映射到 IPC 事件 channel 并推送到 renderer */
export function forwardEventToRenderer(
  mainWindow: BrowserWindow | null,
  event: AgentEvent
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const webContents = mainWindow.webContents
  if (webContents.isDestroyed()) return

  // 轮次边界：先 flush 合帧缓冲，避免 delta 与终态事件错位
  const flushBeforeSend =
    event.type === 'message_start' ||
    event.type === 'tool_call_start' ||
    event.type === 'tool_call' ||
    event.type === 'message_end' ||
    event.type === 'error' ||
    event.type === 'attempt_failed'

  if (flushBeforeSend) {
    flushMainDeltaCoalescer(mainWindow)
  }

  switch (event.type) {
    case 'message_start':
      webContents.send('agent:message-start', { messageId: event.messageId, sessionId: event.sessionId })
      break
    case 'thinking_delta':
      pushMainThinkingDelta(mainWindow, event.messageId, event.delta, event.sessionId)
      break
    case 'text_delta':
      pushMainTextDelta(mainWindow, event.messageId, event.delta, event.sessionId)
      break
    case 'tool_call_start':
      webContents.send('agent:tool-call-start', { messageId: event.messageId, toolCallId: event.toolCallId, toolName: event.toolName, sessionId: event.sessionId })
      break
    case 'tool_call_delta':
      webContents.send('agent:tool-call-delta', { messageId: event.messageId, toolCallId: event.toolCallId, argumentsDelta: event.argumentsDelta, sessionId: event.sessionId })
      break
    case 'tool_call':
      webContents.send('agent:tool-call', { messageId: event.messageId, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, sessionId: event.sessionId })
      break
    case 'tool_result':
      webContents.send('agent:tool-result', {
        messageId: event.messageId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        sessionId: event.sessionId,
        ...(event.artifactId ? { artifactId: event.artifactId } : {}),
        ...(event.truncationMeta ? { truncationMeta: event.truncationMeta } : {})
      })
      break
    case 'permission_request':
      webContents.send('agent:permission-request', {
        messageId: event.messageId,
        requestId: event.requestId,
        toolName: event.toolName,
        args: event.args,
        riskLevel: event.riskLevel,
        reason: event.reason,
        commands: event.commands,
        toolCallIds: event.toolCallIds,
        sessionId: event.sessionId
      })
      break
    case 'diff_update':
      webContents.send('agent:diff-update', {
        messageId: event.messageId,
        phase: event.phase,
        diffs: event.diffs,
        reviews: event.reviews,
        sessionId: event.sessionId
      })
      break
    case 'verification_result':
      webContents.send('agent:verification-result', { messageId: event.messageId, result: event.result, sessionId: event.sessionId })
      break
    case 'verification_permission_request':
      webContents.send('agent:verification-permission-request', {
        messageId: event.messageId,
        requestId: event.requestId,
        command: event.command,
        sessionId: event.sessionId
      })
      break
    case 'verification_permission_cleared':
      webContents.send('agent:verification-permission-cleared', {
        messageId: event.messageId,
        requestId: event.requestId,
        sessionId: event.sessionId
      })
      break
    case 'todos_updated':
      webContents.send('agent:todos-updated', {
        sessionId: event.sessionId,
        todos: event.todos,
        view: event.view
      })
      break
    case 'ask_question_request':
      webContents.send('agent:ask-question-request', {
        requestId: event.requestId,
        questions: event.questions,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.messageId ? { messageId: event.messageId } : {}),
        ...(event.runId ? { runId: event.runId } : {}),
        ...(event.interactionId ? { interactionId: event.interactionId } : {}),
        ...(event.version !== undefined ? { version: event.version } : {})
      })
      break
    case 'ask_question_resolved':
      webContents.send('agent:ask-question-resolved', {
        requestId: event.requestId
      })
      break
    case 'usage':
      webContents.send('agent:usage', {
        messageId: event.messageId,
        usage: event.usage,
        cacheProfileId: event.cacheProfileId,
        sessionId: event.sessionId
      })
      break
    case 'context_breakdown':
      webContents.send('agent:context-breakdown', {
        sessionId: event.sessionId,
        messageId: event.messageId,
        breakdown: event.breakdown,
        totalEstimated: event.totalEstimated,
        promptTokensActual: event.promptTokensActual,
        capturedAt: event.capturedAt
      })
      break
    case 'cache_diagnostic':
      webContents.send('agent:cache-diagnostic', { messageId: event.messageId, diagnostic: event.diagnostic, sessionId: event.sessionId })
      break
    case 'error':
      webContents.send('agent:error', { messageId: event.messageId, error: event.error, sessionId: event.sessionId })
      break
    case 'hook_error':
      webContents.send('agent:hook-error', {
        messageId: event.messageId,
        hookEvent: event.hookEvent,
        error: event.error,
        sessionId: event.sessionId
      })
      break
    case 'recovery_hint':
      webContents.send('agent:recovery-hint', {
        messageId: event.messageId,
        hint: event.hint,
        attempt: event.attempt,
        sessionId: event.sessionId
      })
      break
    case 'recovery_state':
      webContents.send('agent:recovery-state', {
        messageId: event.messageId,
        state: toRendererRecoveryState(event.state),
        sessionId: event.sessionId
      })
      break
    case 'model_switched':
      webContents.send('agent:model-switched', {
        messageId: event.messageId,
        modelId: event.modelId,
        fallbackIndex: event.fallbackIndex,
        reason: event.reason,
        sessionId: event.sessionId
      })
      break
    case 'attempt_failed':
      webContents.send('agent:attempt-failed', {
        messageId: event.messageId,
        attemptId: event.attemptId,
        error: event.error,
        sessionId: event.sessionId
      })
      break
    case 'message_end':
      webContents.send('agent:message-end', {
        messageId: event.messageId,
        sessionId: event.sessionId,
        ...(event.interrupted ? { interrupted: true } : {})
      })
      break
    case 'workflow_phase':
      webContents.send('compose:phase-change', {
        runId: event.runId,
        sessionId: event.sessionId,
        phase: event.phase
      })
      break
    case 'workflow_log':
      webContents.send('compose:log', {
        runId: event.runId,
        sessionId: event.sessionId,
        message: event.message
      })
      break
    case 'workflow_agent_failed':
      // 可观测事件，阶段 E UI 可订阅；当前仅转发为 log
      webContents.send('compose:log', {
        runId: event.runId,
        sessionId: event.sessionId,
        message: `[agent-failed] ${event.reason}`
      })
      break
    case 'workflow_ask_user':
      webContents.send('compose:ask-user', {
        runId: event.runId,
        sessionId: event.sessionId,
        requestId: event.requestId,
        question: event.question,
        options: event.options
      })
      break
    case 'workflow_task_update':
      webContents.send('compose:task-update', {
        runId: event.runId,
        sessionId: event.sessionId,
        tasks: event.tasks
      })
      break
    case 'workflow_state':
      webContents.send('compose:state', {
        runId: event.runId,
        sessionId: event.sessionId,
        state: event.state
      })
      break
  }
}
