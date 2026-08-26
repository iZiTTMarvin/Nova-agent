import type { AskQuestionAnswer } from '../../../shared/askQuestion/types'
import type { PermissionDecision } from '../../../shared/permissions/types'
import type { PathAccessKind } from '../../../shared/permissions/types'
import type { InteractionAnswerResult, PendingInteraction } from '../../../shared/run/types'
import type {
  PlanReviewCommand,
  PlanReviewResolution
} from '../../../shared/planReview'
import type { ToolInvocationRef } from '../../../runtime/tools/types'
import {
  getRunCoordinator,
  getRunExecutionRegistry,
  getActiveRunId
} from '../../services/RunCoordinatorHost'
import { markActiveStreamsCancelled } from '../events'
import { getAgentLoopForRun, disposeIdleLoopForSession } from '../turn'
import {
  pendingAskQuestions,
  dismissPendingAskQuestionsForRun
} from './askQuestionWaiters'
import { planReviewWaiters } from './planReviewWaiters'
import { clearSteeringQueue } from '../turn/SteeringQueue'
import { getSubagentLifecycleCoordinator } from '../../services/SubagentLifecycleHost'

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

function versionMismatchResult(
  expectedVersion: number,
  found: PendingInteraction
): InteractionAnswerResult {
  return {
    ok: false,
    code: 'version_mismatch',
    message: `版本不匹配：期望 ${expectedVersion}，实际 ${found.version}`,
    firstApplied: false,
    snapshot: getRunCoordinator().getSnapshot(found.runId) ?? undefined
  }
}

function planReviewResolution(command: PlanReviewCommand): PlanReviewResolution {
  if (command.decision === 'revise') {
    return { decision: 'revise', feedback: command.feedback! }
  }
  return { decision: command.decision }
}

export async function cancelExecution(params: { runId?: string } = {}): Promise<{ runId: string | null; status: string }> {
  const runId = params.runId ?? getActiveRunId()
  const coord = getRunCoordinator()
  const beforeCancel = runId ? coord.getSnapshot(runId) : null
  if (runId && beforeCancel) {
    const cancelled = await getSubagentLifecycleCoordinator().cancelRunTree(
      runId,
      'cancel_execution'
    )
    for (const cancelledRunId of cancelled.requestedRunIds) {
      markActiveStreamsCancelled(cancelledRunId)
      dismissPendingAskQuestionsForRun(cancelledRunId)
      planReviewWaiters.cancelForRun(cancelledRunId)
    }

    // 会话层面的清理：取消后 idle 压缩窗口不再需要，排队消息也不再处理。
    // 两者都按 sessionId 精确清理，不影响并发中的其它会话。
    const sessionId = beforeCancel.sessionId
    if (sessionId) {
      disposeIdleLoopForSession(sessionId)
      clearSteeringQueue(sessionId)
    }
  }

  // 有执行句柄时终态由 sendMessage finally 确认；无句柄 run 已在上方同步终止。
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
  const foundSnapshot = found ? coord.getSnapshot(found.runId) : null
  const durableOnlyRecovery = foundSnapshot?.status === 'interrupted'
  if (found && isPendingInteraction(found)) {
    if (!params.commandId) {
      return identityMismatchResult('权限请求缺少 exactly-once commandId', found)
    }
    if (!durableOnlyRecovery) {
      const executionError = liveExecutionIdentityError(found)
      if (executionError) return identityMismatchResult(executionError, found)
      if (!loopForRun) {
        return identityMismatchResult(`run ${found.runId} 没有对应的 AgentLoop`, found)
      }
      const hasResolver = loopForRun.hasPendingPermission(params.requestId)
      if (!hasResolver) {
        return identityMismatchResult(`权限请求 ${params.requestId} 没有对应的 resolver`, found)
      }
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

  // 仅 firstApplied 时执行副作用：按 durable run 直达其 AgentLoop resolver。
  if (loopForRun?.hasPendingPermission(params.requestId)) {
    loopForRun.respondPermission(params.requestId, granted)
    return durableResult
  }
  if (durableOnlyRecovery) return durableResult
  // 并发模型下不再有全局 loop 兜底；权限响应必须命中具体 run 的 AgentLoop
  if (!loopForRun) return
  loopForRun.respondPermission(params.requestId, granted)
  return durableResult
}

export function assertCanGrantSessionPath(params: {
  requestId: string
  sessionId: string
  canonicalPath: string
  access: PathAccessKind
  interactionId?: string
}): void {
  const interactionId = params.interactionId ?? params.requestId
  const coord = getRunCoordinator()
  const found = coord.findInteraction(interactionId)
  const identityError = interactionIdentityError(
    found,
    { requestId: params.requestId, interactionId },
    'permission'
  )
  if (identityError) {
    throw new Error(`权限请求身份不匹配：${identityError}`)
  }
  if (!found || !isPendingInteraction(found)) {
    throw new Error(`权限请求 ${params.requestId} 不存在或已处理`)
  }
  if (found.sessionId !== params.sessionId) {
    throw new Error('权限请求会话不匹配')
  }

  const executionError = liveExecutionIdentityError(found)
  if (executionError) throw new Error(executionError)

  const loopForRun = getAgentLoopForRun(found.runId)
  if (!loopForRun || !loopForRun.hasPendingPermission(params.requestId)) {
    throw new Error(`权限请求 ${params.requestId} 没有对应的 resolver`)
  }

  const externalPaths = found.payload.externalPaths
  if (!Array.isArray(externalPaths) || !externalPaths.includes(params.canonicalPath)) {
    throw new Error('目录授权路径不属于当前权限请求')
  }
  if (found.payload.pathAccess !== params.access) {
    throw new Error('目录授权访问类型不属于当前权限请求')
  }
}

export async function respondPlanReview(
  command: PlanReviewCommand
): Promise<InteractionAnswerResult> {
  const coord = getRunCoordinator()
  const found = coord.findInteraction(command.interactionId)
  if (!found) {
    return coord.inbox.answer({
      interactionId: command.interactionId,
      commandId: command.commandId,
      expectedVersion: command.expectedVersion,
      outcome: command.decision === 'approve' ? 'answered' : 'dismissed',
      payload: {
        decision: command.decision,
        ...(command.feedback ? { feedback: command.feedback } : {})
      }
    })
  }

  const snapshot = coord.getSnapshot(found.runId)
  if (!snapshot || snapshot.sessionId !== found.sessionId || snapshot.runId !== found.runId) {
    return identityMismatchResult('计划审阅 interaction 的 run/session 归属无效', found)
  }

  let resolveApplied: (() => void) | null = null
  if (found.type === 'permission') {
    const args = found.payload.args
    const requestId = found.payload.requestId
    if (
      found.payload.toolName !== 'switch_mode' ||
      typeof requestId !== 'string' ||
      typeof args !== 'object' ||
      args === null ||
      (args as Record<string, unknown>).mode !== 'default'
    ) {
      return identityMismatchResult('该 permission 不是退出 plan 的 switch_mode(default) 请求', found)
    }

    if (isPendingInteraction(found)) {
      if (found.version !== command.expectedVersion) {
        return versionMismatchResult(command.expectedVersion, found)
      }
      const executionError = liveExecutionIdentityError(found)
      if (executionError) return identityMismatchResult(executionError, found)
      const loop = getAgentLoopForRun(found.runId)
      if (!loop || !loop.hasPendingPermission(requestId)) {
        return identityMismatchResult(`计划审阅权限请求 ${requestId} 没有对应的 resolver`, found)
      }
      const resolution = planReviewResolution(command)
      resolveApplied = () => loop.respondPlanReview(requestId, resolution)
    }
  } else if (found.type === 'planApproval') {
    const toolCallId = found.payload.toolCallId
    if (
      found.payload.toolName !== 'stage_transition' ||
      found.payload.action !== 'complete' ||
      typeof toolCallId !== 'string' ||
      toolCallId.trim().length === 0
    ) {
      return identityMismatchResult('该 planApproval 不是 stage_transition complete 请求', found)
    }

    if (isPendingInteraction(found)) {
      if (found.version !== command.expectedVersion) {
        return versionMismatchResult(command.expectedVersion, found)
      }
      const executionError = liveExecutionIdentityError(found)
      if (executionError) return identityMismatchResult(executionError, found)
      const ref: ToolInvocationRef = {
        runId: found.runId,
        sessionId: found.sessionId,
        messageId: found.messageId,
        toolCallId
      }
      if (!planReviewWaiters.has(found.interactionId, ref)) {
        return identityMismatchResult(`计划审阅 ${found.interactionId} 没有匹配的 waiter`, found)
      }
      const resolution = planReviewResolution(command)
      resolveApplied = () => {
        planReviewWaiters.resolve(found.interactionId, resolution)
      }
    }
  } else {
    return identityMismatchResult(`interaction 类型不支持计划审阅：${found.type}`, found)
  }

  const result = coord.inbox.answer({
    interactionId: command.interactionId,
    commandId: command.commandId,
    expectedVersion: command.expectedVersion,
    outcome: command.decision === 'approve' ? 'answered' : 'dismissed',
    payload: {
      decision: command.decision,
      ...(command.feedback ? { feedback: command.feedback } : {})
    }
  })
  if (!result.ok || !result.firstApplied) return result
  resolveApplied?.()
  return result
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
