import {
  isTerminalRunStatus,
  type CommitTerminalParams,
  type RunSnapshot
} from '../../../shared/run/types'

interface RunTerminalPort {
  getSnapshot(runId: string): Pick<RunSnapshot, 'status'> | null
  commitTerminal(params: CommitTerminalParams): void
}

/**
 * start/resume 成功后的异常必须收敛到 durable 终态。
 * 已经由执行路径提交终态时保持幂等，不覆盖原始完成原因。
 */
export function interruptStartedRunAfterFailure(
  coordinator: RunTerminalPort,
  runId: string | null,
  error: unknown
): boolean {
  if (!runId) return false

  const snapshot = coordinator.getSnapshot(runId)
  if (!snapshot || isTerminalRunStatus(snapshot.status)) return false

  coordinator.commitTerminal({
    runId,
    status: 'interrupted',
    reason: error instanceof Error ? error.message : String(error || 'run_setup_failed')
  })
  return true
}
