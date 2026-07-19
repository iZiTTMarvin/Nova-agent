import type { AskQuestionAnswer } from '../../../shared/askQuestion/types'
import type { PermissionDecision } from '../../../shared/session/types'
import type { InteractionAnswerResult, PendingInteraction } from '../../../shared/run/types'
import { defaultSubAgentPermissionBridge } from '../../../runtime/tools/subAgentBridge'
import {
  getRunCoordinator,
  getXForgeRunService,
  getRunExecutionRegistry,
  getActiveRunId
} from '../../services/RunCoordinatorHost'
import {
  clearPendingVerificationPermissions,
  clearVerificationPermissionRequest,
  markActiveStreamsCancelled
} from '../events'
import { getAgentLoopForRun, getCurrentAgentLoop } from '../turn'
import {
  pendingAskQuestions,
  dismissPendingAskQuestionsForRun
} from './askQuestionWaiters'

/** 校验 IPC 请求指向的 durable interaction，返回不匹配原因。 */
function interactionIdentityError(
  found: PendingInteraction | null,
  params: { requestId: string; interactionId: string },
  expectedType: 'permission' | 'askQuestion'
): string | null {
  if (!found) return null
  if (found.interactionId !== params.interactionId) {
    return `interactionId 不匹配：expected=${params.interactionId}, actual=${found.interactionId}`
  }
  if (found.type !== expectedType) {
    return `interaction 类型不匹配：expected=${expectedType}, actual=${found.type}`
  }
  const payloadRequestId = found.payload.requestId
  if (typeof payloadRequestId === 'string' && payloadRequestId !== params.requestId) {
    return `requestId 不匹配：expected=${params.requestId}, actual=${payloadRequestId}`
  }

  const snapshot = getRunCoordinator().getSnapshot(found.runId)
  if (!snapshot) return `run ${found.runId} 不存在`
  if (snapshot.runId !== found.runId || snapshot.sessionId !== found.sessionId) {
    return `interaction 的 run/session 归属与 snapshot 不一致`
  }
  return null
}

/** 首次回答 pending interaction 前确认本进程仍拥有同一 generation 的执行。 */
function liveExecutionIdentityError(found: PendingInteraction): string | null {
  const coordinator = getRunCoordinator()
  const snapshot = coordinator.getSnapshot(found.runId)
  const handle = getRunExecutionRegistry().get(found.runId)
  if (!snapshot || !handle) {
    return `run ${found.runId} 没有可恢复的进程内执行`
  }
  if (
    snapshot.executionGeneration !== handle.generation ||
    !getRunExecutionRegistry().isCurrent(found.runId, handle.generation)
  ) {
    return `run ${found.runId} 的 execution generation 已失效`
  }
  return null
}

function isPendingInteraction(found: PendingInteraction): boolean {
  return found.status === 'pending' || found.status === 'submitting'
}

function identityMismatchResult(
  message: string,
  found: PendingInteraction | null
): InteractionAnswerResult {
  const coord = getRunCoordinator()
  return {
    ok: false,
    code: 'identity_mismatch',
    message,
    firstApplied: false,
    ...(found ? { snapshot: coord.getSnapshot(found.runId) ?? undefined } : {})
  }
}

export async function cancelExecution(params: { runId?: string } = {}): Promise<{ runId: string | null; status: string }> {
  const runId = params.runId ?? getActiveRunId()
  const coord = getRunCoordinator()
  const beforeCancel = runId ? coord.getSnapshot(runId) : null
  const hasExecutionHandle = runId ? getRunExecutionRegistry().get(runId) !== null : false
  if (runId && beforeCancel) {
    coord.beginCancel(runId)
    coord.inbox.cancelAllForRun(runId)

    if (hasExecutionHandle) {
      // abort 会等待执行收敛；终态仍由 SEND_MESSAGE 的 finally 统一提交。
      await getRunExecutionRegistry().abort(runId, 'cancel_execution')
      defaultSubAgentPermissionBridge.cancelAll()
      defaultSubAgentPermissionBridge.clear()
      markActiveStreamsCancelled(runId)
    } else if (beforeCancel.kind === 'xforge' && beforeCancel.xforge) {
      // parked XForge 没有执行句柄，必须在此原子落终态，不能遗留 cancelling。
      getXForgeRunService().cancelParkedXForgeRun(
        runId,
        '用户取消已暂停的 XForge 运行'
      )
    } else {
      coord.commitTerminal({ runId, status: 'cancelled', reason: '用户取消未执行的运行' })
    }

    clearPendingVerificationPermissions(runId)
    dismissPendingAskQuestionsForRun(runId)
  }

  // 有执行句柄时终态由 sendMessage finally 确认；parked XForge 已在上方同步终止。
  const snap = runId ? coord.getSnapshot(runId) : null
  return { runId, status: snap?.status ?? 'idle' }
}

export async function respondPermission(params: {
  requestId: string
  decision: PermissionDecision
  commandId?: string
  expectedVersion?: number
  interactionId?: string
}): Promise<void | InteractionAnswerResult> {
  const granted = params.decision === 'allow'
  const interactionId = params.interactionId ?? params.requestId
  const coord = getRunCoordinator()
  const found = coord.findInteraction(interactionId)
  const identityError = interactionIdentityError(
    found,
    { requestId: params.requestId, interactionId },
    'permission'
  )

  if (identityError) {
    return identityMismatchResult(
      `权限请求身份不匹配：${identityError}`,
      found
    )
  }

  const loopForRun = found ? getAgentLoopForRun(found.runId) : undefined
  if (found && isPendingInteraction(found)) {
    if (!params.commandId) {
      return identityMismatchResult('权限请求缺少 exactly-once commandId', found)
    }
    const executionError = liveExecutionIdentityError(found)
    if (executionError) return identityMismatchResult(executionError, found)
    if (!loopForRun) {
      return identityMismatchResult(`run ${found.runId} 没有对应的 AgentLoop`, found)
    }
    const hasResolver =
      loopForRun.hasPendingPermission(params.requestId) ||
      defaultSubAgentPermissionBridge.hasBinding(params.requestId)
    if (!hasResolver) {
      return identityMismatchResult(`权限请求 ${params.requestId} 没有对应的 resolver`, found)
    }
  }

  // InteractionInbox 幂等路径（有 commandId 时）
  let durableResult: InteractionAnswerResult | undefined
  if (params.commandId && found) {
    const result = coord.inbox.answer({
      interactionId,
      commandId: params.commandId,
      expectedVersion: params.expectedVersion ?? found.version,
      outcome: granted ? 'answered' : 'dismissed',
      payload: { decision: params.decision }
    })
    // 失败或重复命令：直接返回 ACK，不得再调 AgentLoop
    if (!result.ok || !result.firstApplied) return result
    durableResult = result
  } else if (params.commandId && !found) {
    // 无 interaction 时仍走 answer，以便返回持久化 duplicate ACK
    const result = coord.inbox.answer({
      interactionId,
      commandId: params.commandId,
      expectedVersion: params.expectedVersion ?? 1,
      outcome: granted ? 'answered' : 'dismissed',
      payload: { decision: params.decision }
    })
    if (!result.ok || !result.firstApplied) return result
  }

  // 仅 firstApplied 时执行副作用：按 run 定位 loop，避免错唤醒
  if (defaultSubAgentPermissionBridge.resolve(params.requestId, granted)) {
    return durableResult
  }
  const agentLoop = found ? loopForRun : getCurrentAgentLoop()
  if (!agentLoop) return
  agentLoop.respondPermission(params.requestId, granted)
  return durableResult
}

/**
 * 验证权限响应。
 *
 * 验证发生在 message_end 之后的异步路径，带超时，属于进程内 waiter，
 * 不得写入 InteractionInbox（否则会把已结束/即将结束的 run 拖入 waiting_user）。
 */
export async function respondVerificationPermission(params: {
  requestId: string
  granted: boolean
  commandId?: string
  expectedVersion?: number
  interactionId?: string
}): Promise<void | InteractionAnswerResult> {
  clearVerificationPermissionRequest(params.requestId, params.granted)
}

export async function respondAskQuestion(params: {
  requestId: string
  answers: AskQuestionAnswer[]
  commandId?: string
  expectedVersion?: number
  interactionId?: string
}): Promise<void | InteractionAnswerResult> {
  const interactionId = params.interactionId ?? params.requestId
  const coord = getRunCoordinator()
  const found = coord.findInteraction(interactionId)
  const dismissed = !params.answers || params.answers.length === 0
  const identityError = interactionIdentityError(
    found,
    { requestId: params.requestId, interactionId },
    'askQuestion'
  )

  if (identityError) {
    return identityMismatchResult(
      `askQuestion 身份不匹配：${identityError}`,
      found
    )
  }

  const entry = pendingAskQuestions.get(params.requestId)
  if (found && isPendingInteraction(found)) {
    if (!params.commandId) {
      return identityMismatchResult('askQuestion 请求缺少 exactly-once commandId', found)
    }
    const executionError = liveExecutionIdentityError(found)
    if (executionError) return identityMismatchResult(executionError, found)
    if (!entry) {
      return identityMismatchResult(`askQuestion ${params.requestId} 没有进程内 waiter`, found)
    }
    if (entry.runId !== found.runId) {
      return identityMismatchResult(
        `askQuestion run 不匹配：interaction.runId=${found.runId}, waiter.runId=${entry.runId}`,
        found
      )
    }
  }

  let durableResult: InteractionAnswerResult | undefined
  if (params.commandId) {
    const result = coord.inbox.answer({
      interactionId,
      commandId: params.commandId,
      expectedVersion: params.expectedVersion ?? found?.version ?? 1,
      outcome: dismissed ? 'dismissed' : 'answered',
      payload: { answers: params.answers }
    })
    // 重复 command：返回第一次完整 ACK，不得再 resolve / 不得返回 not_found
    if (!result.ok || !result.firstApplied) return result
    durableResult = result
  }

  if (!entry) {
    if (params.commandId) {
      return {
        ok: false,
        code: 'not_found',
        message: `askQuestion ${params.requestId} 不存在`,
        firstApplied: true
      }
    }
    return
  }

  pendingAskQuestions.delete(params.requestId)
  entry.resolve(params.answers)
  entry.eventBus.emit({ type: 'ask_question_resolved', requestId: params.requestId })

  return durableResult
}
