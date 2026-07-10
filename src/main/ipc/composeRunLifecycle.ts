/**
 * Compose 路径与 RunCoordinator / RunExecutionRegistry 的生命周期桥接。
 * 与 agentHandler SEND_MESSAGE 同构：startRun → bindGeneration → register → markRunning →
 * 执行 → commitTerminal → settled/unregister。
 * 抽成纯函数便于单测，不依赖 Electron。
 */
import type { RunCoordinator } from '../../runtime/run/RunCoordinator'
import type { RunExecutionRegistry } from '../../runtime/run/RunExecutionRegistry'
import type { RunOutcome, RunWorkflowOptions } from '../../runtime/workflow/types'

export interface ComposeLifecycleDeps {
  coord: RunCoordinator
  registry: RunExecutionRegistry
  /** 实际执行编排（可注入 mock） */
  runWorkflow: (opts: RunWorkflowOptions) => Promise<RunOutcome>
  /** 取消时调用（registry.abort → 此回调） */
  cancelWorkflow: (runId: string) => boolean
}

export interface ComposeLifecycleParams {
  workspaceRoot: string
  sessionId?: string
  /** resume / 指定 runId；缺省由 coordinator 生成 UUID */
  runId?: string
  resume?: boolean
  workflowOpts: Omit<RunWorkflowOptions, 'runId' | 'resume' | 'assertExecutionCurrent' | 'abortSignal'>
  /** run 已 start + markRunning 后回调（供 setActiveRunId） */
  onRunStarted?: (runId: string) => void
}

export interface ComposeLifecycleResult {
  runId: string
  status: RunOutcome['status']
  error?: string
}

/**
 * 在 RunCoordinator 权威状态下跑一次 compose workflow。
 * workflow.runId 与 coordinator.runId 强制统一，保证 inbox / snapshot 对齐。
 */
export async function runComposeWithLifecycle(
  deps: ComposeLifecycleDeps,
  params: ComposeLifecycleParams
): Promise<ComposeLifecycleResult> {
  const { coord, registry } = deps

  // 禁止与未收敛的 compose 执行重叠（全局 compose 句柄）
  if (registry.hasUnsettledHandle('compose')) {
    throw new Error('上一次 Compose 执行尚未完全退出，请稍候再试')
  }

  const snap = coord.startRun({
    kind: 'compose',
    workspaceId: params.workspaceRoot,
    sessionId: params.sessionId ?? '',
    ...(params.runId ? { runId: params.runId } : {})
  })
  const runId = snap.runId
  const executionGeneration = Date.now()

  let resolveSettled!: () => void
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })

  const abortController = new AbortController()
  registry.register({
    runId,
    generation: executionGeneration,
    kind: 'compose',
    abort: () => {
      abortController.abort()
      deps.cancelWorkflow(runId)
    },
    settled
  })
  coord.bindExecutionGeneration(runId, executionGeneration)
  coord.markRunning(runId)
  params.onRunStarted?.(runId)

  let turnFailed = false
  let outcome: RunOutcome
  try {
    outcome = await deps.runWorkflow({
      ...params.workflowOpts,
      runId,
      resume: params.resume,
      abortSignal: abortController.signal,
      assertExecutionCurrent: () => coord.isExecutionCurrent(runId, executionGeneration)
    })

    const terminalStatus =
      outcome.status === 'completed'
        ? 'completed'
        : outcome.status === 'cancelled'
          ? 'cancelled'
          : 'failed'

    if (terminalStatus === 'cancelled') {
      coord.beginCancel(runId)
    }
    coord.commitTerminal({
      runId,
      status: terminalStatus,
      reason:
        outcome.status === 'failed'
          ? outcome.error ?? 'compose_failed'
          : outcome.status === 'cancelled'
            ? 'compose_cancelled'
            : undefined
    })

    return {
      runId: outcome.runId,
      status: outcome.status,
      ...(outcome.status === 'failed' && outcome.error ? { error: outcome.error } : {})
    }
  } catch (err) {
    turnFailed = true
    const reason = err instanceof Error ? err.message : String(err)
    try {
      coord.commitTerminal({
        runId,
        status: 'failed',
        reason
      })
    } catch {
      /* ignore */
    }
    throw err
  } finally {
    // 若尚未终态（异常路径已 commit；正常路径已 commit），补 completed
    if (!turnFailed) {
      const current = coord.getSnapshot(runId)
      if (current && !['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status)) {
        const cancelled = current.status === 'cancelling'
        coord.commitTerminal({
          runId,
          status: cancelled ? 'cancelled' : 'completed'
        })
      }
    }
    resolveSettled()
    registry.unregister(runId, executionGeneration)
  }
}
