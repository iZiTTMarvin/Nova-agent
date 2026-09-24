/**
 * Subagent tool settlement port — pure query, no model calls, no storage writes.
 * Given a parent's task / batch_task / task_followup tool call, returns frozen result text.
 */
import type { RunCoordinator } from '../run/RunCoordinator'
import { deriveChildSessionId } from '../sessions'
import type { SessionStore } from '../sessions'
import type { SessionData, SubagentSessionData } from '../sessions/types'
import { buildSubagentToolResult } from './resultText'
import { projectSubagentExecutionResult } from './resultProjection'
import {
  computeBatchItemDigest,
  createFollowupSpawnIdentity,
  createSpawnIdentity,
  deriveBatchItemToolCallId
} from './identity'
import {
  decodeBatchInput,
  formatBatchSubagentOutput,
  parseFollowupArguments,
  type BatchSubagentItemResult,
  type SubagentExecutionResult
} from '../../shared/subagents'
import type { SubagentFailureCode } from '../../shared/subagents'
import { isTerminalRunStatus, type RunSnapshot } from '../../shared/run/types'

export interface SubagentToolSettlementInput {
  readonly sessionId: string
  readonly parentRunId: string
  readonly parentMessageId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly args: unknown
}

export interface SubagentToolSettlement {
  readonly status: 'success' | 'error'
  readonly result: string
}

export interface SubagentToolSettlementDeps {
  readonly sessionStore: SessionStore
  readonly runCoordinator: RunCoordinator
}

function isSubagentSession(session: SessionData): session is SubagentSessionData {
  return session.kind === 'subagent'
}

function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return {}
}

function deriveFailureCode(run: RunSnapshot): SubagentFailureCode | undefined {
  const reason = run.terminalReason?.trim()
  if (reason?.startsWith('scheduler:')) return 'scheduler'
  if (reason?.startsWith('子代理执行超时')) return 'timeout'
  return undefined
}

function buildHeader(
  kind: 'task' | 'followup',
  profileId: string,
  childSessionId: string,
  runId: string
): string {
  const prefix = kind === 'followup' ? '子代理续跑' : '子代理'
  return `[${prefix} ${profileId} / 会话 ${childSessionId} / run ${runId}]`
}

function formatInterrupted(
  header: string,
  runSnapshot: RunSnapshot,
  hasResultMessage: boolean,
  summary: string
): string {
  const commits = (runSnapshot.toolCommits ?? []).filter(r => r.phase === 'committed').length
  const lines: string[] = [
    `工具执行失败: 子代理执行已中断（进程退出时已确认）。已提交工具调用 ${commits} 个（仅为已确认提交计数，不代表执行进度）。可通过 task_followup 以 child_session_id="${header.match(/会话 ([^/]+)/)?.[1] ?? ''}"、resume_run_id="${runSnapshot.runId}" 显式继续，或用 subagent_read 读回已有输出。`,
    header
  ]
  if (hasResultMessage) lines.push(summary)
  return lines.join('\n')
}

function settlementError(message: string): SubagentToolSettlement {
  return { status: 'error', result: message }
}

function settlementSuccess(result: string): SubagentToolSettlement {
  return { status: 'success', result }
}

/** Settle a single task or batch-item tool call. */
function settleSingle(
  input: SubagentToolSettlementInput,
  child: SubagentSessionData | null,
  run: RunSnapshot | null,
  invocationKind: 'task_tool' | 'task_followup',
  headerProfileId: string
): SubagentToolSettlement {
  const childSessionId = child?.id ?? ''
  const runId = run?.runId ?? ''

  // Both absent
  if (!child && !run) {
    return settlementError(
      `工具执行失败: 未找到该调用的子代理持久记录（会话 …/run … 均不存在）；进程可能在创建前退出，任务未被执行，可按原参数重新派遣`
    )
  }

  // Child exists, run absent
  if (child && !run) {
    return settlementError(
      `工具执行失败: 子代理会话已创建但无执行记录（run ${runId || '…'} 不存在）；进程在接纳执行前退出，任务未被执行`
    )
  }

  // Run exists, child absent
  if (run && !child) {
    return settlementError(
      `工具执行失败: 执行记录存在但子会话缺失/不可读（会话 ${childSessionId || '…'}，run ${runId}）`
    )
  }

  // Both present: verify non-terminal
  if (!run || !isTerminalRunStatus(run.status)) {
    return settlementError(
      `工具执行失败: 结算时尚未收到终态（当前状态 ${run?.status ?? '…'}）；不声称已完成或已取消。会话 ${childSessionId}/run ${runId}，可稍后通过 subagent_read 查询`
    )
  }

  const terminalRun = run

  // Project result
  const failureCode = deriveFailureCode(terminalRun)
  const projected: SubagentExecutionResult = {
    childSessionId,
    childRunId: runId,
    status: terminalRun.status === 'completed' ? 'completed' : (terminalRun.status as SubagentExecutionResult['status']),
    summary: terminalRun.terminalReason ?? '',
    artifactIds: [],
    startedAt: terminalRun.turnStartedAt ?? terminalRun.createdAt,
    completedAt: terminalRun.updatedAt,
    hasResultMessage: false
  }

  const fullProjected = (() => {
    try {
      return projectSubagentExecutionResult({ childSession: child!, runSnapshot: terminalRun, failureCode })
    } catch {
      return projected
    }
  })()

  const header = buildHeader(
    invocationKind === 'task_followup' ? 'followup' : 'task',
    headerProfileId,
    childSessionId,
    runId
  )

  // completed, no incompleteReason, hasResultMessage → success
  if (
    terminalRun.status === 'completed' &&
    !terminalRun.incompleteReason &&
    fullProjected.hasResultMessage
  ) {
    return settlementSuccess(buildSubagentToolResult(header, fullProjected).output)
  }

  // completed, no incompleteReason, hasResultMessage === false
  if (terminalRun.status === 'completed' && !terminalRun.incompleteReason && !fullProjected.hasResultMessage) {
    return settlementError(
      `工具执行失败: 子代理已完成，但结果消息记录不可读（run ${runId} 的消息 ${child?.id ?? ''} 在子会话中缺失）；状态已完成，不要重新执行，可用 subagent_read 检查子会话 ${childSessionId}`
    )
  }

  // completed + incompleteReason / failed / cancelled
  if (
    (terminalRun.status === 'completed' && terminalRun.incompleteReason) ||
    terminalRun.status === 'failed' ||
    terminalRun.status === 'cancelled'
  ) {
    const { output, error } = buildSubagentToolResult(header, fullProjected)
    return settlementError(`工具执行失败: ${error ?? terminalRun.terminalReason ?? '未知'}\n${output}`)
  }

  // interrupted
  if (terminalRun.status === 'interrupted') {
    return settlementError(
      formatInterrupted(header, terminalRun, fullProjected.hasResultMessage, fullProjected.summary)
    )
  }

  return settlementError(`工具执行失败: 未知的执行状态 ${terminalRun.status}`)
}

/** Settle a batch_task tool call. */
function settleBatch(
  input: SubagentToolSettlementInput,
  deps: SubagentToolSettlementDeps
): SubagentToolSettlement {
  const rawArgs = normalizeArgs(input.args)
  let decoded: ReturnType<typeof decodeBatchInput>
  try {
    decoded = decodeBatchInput(rawArgs)
  } catch (error) {
    return settlementError(
      `工具执行失败: 批次参数无法解析（${error instanceof Error ? error.message : String(error)}），无法逐项定位；toolCallId ${input.toolCallId}`
    )
  }

  const digest = computeBatchItemDigest(decoded.items)
  const ordered: BatchSubagentItemResult[] = []

  for (const item of decoded.items) {
    const perItemToolCallId = deriveBatchItemToolCallId(input.toolCallId, digest, item.itemId)
    const identity = createSpawnIdentity({
      parentRunId: input.parentRunId,
      invocation: { kind: 'task_tool', parentMessageId: input.parentMessageId, parentToolCallId: perItemToolCallId }
    })
    const childSessionId = deriveChildSessionId(identity.spawnKey)
    const child = deps.sessionStore.load(childSessionId)
    const run = deps.runCoordinator.getSnapshot(identity.spawnRunId)

    // Both absent
    if (!child && !run) {
      ordered.push({
        itemId: item.itemId,
        status: 'rejected',
        failure: { code: 'host', message: '进程退出前未创建该子任务的执行记录' }
      })
      continue
    }

    // Child exists, run absent
    if (child && !run) {
      ordered.push({
        itemId: item.itemId,
        status: 'rejected',
        childSessionId: child.id,
        failure: { code: 'host', message: '子代理会话已创建但无执行记录，进程在接纳执行前退出' }
      })
      continue
    }

    // Run exists, child absent
    if (run && !child) {
      ordered.push({
        itemId: item.itemId,
        status: 'rejected',
        failure: { code: 'host', message: '调用身份与持久记录冲突（含 id）' }
      })
      continue
    }

    // Identity verification
    if (
      isSubagentSession(child!) &&
      child!.subagent.lineage.parentSessionId !== input.sessionId
    ) {
      ordered.push({
        itemId: item.itemId,
        status: 'rejected',
        failure: { code: 'host', message: `调用身份与持久记录冲突（含 id）` }
      })
      continue
    }

    // Non-terminal
    if (!isTerminalRunStatus(run!.status)) {
      ordered.push({
        itemId: item.itemId,
        status: 'unsettled',
        childSessionId,
        childRunId: run!.runId,
        failure: {
          code: 'host',
          message: `结算时尚未收到终态（当前 ${run!.status}）`
        }
      })
      continue
    }

    // Terminal — project
    let projected: SubagentExecutionResult
    try {
      projected = projectSubagentExecutionResult({ childSession: child!, runSnapshot: run!, failureCode: deriveFailureCode(run!) })
    } catch {
      projected = {
        childSessionId,
        childRunId: run!.runId,
        status: run!.status === 'completed' ? 'completed' : (run!.status as SubagentExecutionResult['status']),
        summary: run!.terminalReason ?? '',
        artifactIds: [],
        startedAt: run!.turnStartedAt ?? run!.createdAt,
        completedAt: run!.updatedAt,
        hasResultMessage: false
      }
    }

    ordered.push({
      itemId: item.itemId,
      status: projected.status,
      summary: projected.summary,
      childSessionId,
      childRunId: run!.runId,
      ...(projected.failure ? { failure: projected.failure } : {}),
      ...(projected.incompleteReason ? { incompleteReason: projected.incompleteReason } : {})
    })
  }

  const { output, hasFailure, error } = formatBatchSubagentOutput(ordered)
  if (hasFailure) {
    return settlementError(`工具执行失败: ${error}\n${output}`)
  }
  return settlementSuccess(output)
}

/**
 * Settle a subagent tool call by exact identity coordinates.
 * Pure query: no model calls, no storage writes.
 */
export function settleSubagentToolCall(
  deps: SubagentToolSettlementDeps,
  input: SubagentToolSettlementInput
): SubagentToolSettlement | null {
  if (
    input.toolName !== 'task' &&
    input.toolName !== 'batch_task' &&
    input.toolName !== 'task_followup'
  ) {
    return null
  }

  try {
    if (input.toolName === 'batch_task') {
      return settleBatch(input, deps)
    }

    const rawArgs = normalizeArgs(input.args)

    if (input.toolName === 'task_followup') {
      const parsed = parseFollowupArguments(rawArgs)
      if (!parsed) {
        return settlementError(
          `工具执行失败: task_followup 参数无法解析（child_session_id 或 task 为空或格式错误）`
        )
      }
      const identity = createFollowupSpawnIdentity({
        parentRunId: input.parentRunId,
        parentMessageId: input.parentMessageId,
        parentToolCallId: input.toolCallId,
        previousChildSessionId: parsed.childSessionId
      })
      const child = deps.sessionStore.load(parsed.childSessionId)
      const run = deps.runCoordinator.getSnapshot(identity.spawnRunId)

      // Attribution: child.kind === 'subagent' && lineage.parentSessionId === input.sessionId
      if (child && !isSubagentSession(child)) {
        return settlementError(
          `工具执行失败: 调用身份与持久记录冲突（child 会话 ${parsed.childSessionId} 不属于该父 ${input.sessionId}）`
        )
      }
      if (
        child &&
        isSubagentSession(child) &&
        child.subagent.lineage.parentSessionId !== input.sessionId
      ) {
        return settlementError(
          `工具执行失败: 调用身份与持久记录冲突（child 会话 ${parsed.childSessionId} 不属于该父 ${input.sessionId}）`
        )
      }

      // Run session match
      if (run && run.sessionId !== parsed.childSessionId) {
        return settlementError(
          `工具执行失败: 调用身份与持久记录冲突（run ${run.runId} 不属于 child 会话 ${parsed.childSessionId}）`
        )
      }

      // Run absent
      if (!run) {
        return settlementError(
          `工具执行失败: 该次续跑未留下执行记录（run … 不存在）；指令可能已写入子会话但未被执行`
        )
      }

      const profileId =
        child && isSubagentSession(child)
          ? child.subagent.profile.profileId
          : '未知'
      return settleSingle(input, child as SubagentSessionData | null, run, 'task_followup', profileId)
    }

    // task
    const identity = createSpawnIdentity({
      parentRunId: input.parentRunId,
      invocation: {
        kind: 'task_tool',
        parentMessageId: input.parentMessageId,
        parentToolCallId: input.toolCallId
      }
    })
    const childSessionId = deriveChildSessionId(identity.spawnKey)
    const child = deps.sessionStore.load(childSessionId)
    const run = deps.runCoordinator.getSnapshot(identity.spawnRunId)

    // Attribution: child.kind === 'subagent' && lineage.parentSessionId === input.sessionId &&
    //             lineage.parentRunId === input.parentRunId && lineage.spawnRunId === identity.spawnRunId &&
    //             origin.kind === 'task_tool' && origin.parentMessageId === input.parentMessageId &&
    //             origin.parentToolCallId === input.toolCallId
    if (child) {
      if (!isSubagentSession(child)) {
        return settlementError(
          `工具执行失败: 调用身份与持久记录冲突（child 会话 ${childSessionId} 不属于该父 ${input.sessionId}）`
        )
      }
      const lin = child.subagent.lineage
      if (
        lin.parentSessionId !== input.sessionId ||
        lin.parentRunId !== input.parentRunId ||
        lin.spawnRunId !== identity.spawnRunId
      ) {
        return settlementError(
          `工具执行失败: 调用身份与持久记录冲突（含两侧 id）`
        )
      }
      if (lin.origin.kind !== 'task_tool') {
        return settlementError(
          `工具执行失败: 调用身份与持久记录冲突（origin.kind 不匹配）`
        )
      }
      if (
        lin.origin.parentMessageId !== input.parentMessageId ||
        lin.origin.parentToolCallId !== input.toolCallId
      ) {
        return settlementError(
          `工具执行失败: 调用身份与持久记录冲突（含两侧 id）`
        )
      }
    }

    // Run session match: run.sessionId is set when the run is created for the child
    if (run && run.sessionId !== childSessionId) {
      return settlementError(
        `工具执行失败: 调用身份与持久记录冲突（run ${run.runId} 不属于 child 会话 ${childSessionId}）`
      )
    }

    // Extract profileId from args or child
    let profileId: string
    if (child && isSubagentSession(child)) {
      profileId = child.subagent.profile.profileId
    } else {
      const subagentType = rawArgs.subagent_type
      profileId = typeof subagentType === 'string' && subagentType.trim()
        ? subagentType.trim()
        : '未知'
    }

    return settleSingle(input, child as SubagentSessionData | null, run, 'task_tool', profileId)
  } catch (error) {
    return settlementError(
      `工具执行失败: 记录缺失/损坏（${error instanceof Error ? error.message : String(error)}）`
    )
  }
}
