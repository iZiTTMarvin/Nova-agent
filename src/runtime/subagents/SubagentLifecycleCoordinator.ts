import type { RunCoordinator } from '../run/RunCoordinator'
import type { AbortResult, RunExecutionRegistry } from '../run/RunExecutionRegistry'
import type { SessionStore } from '../sessions/SessionStore'
import { writerLeaseRegistry } from '../workspace'
import { isTerminalRunStatus, type RunSnapshot } from '../../shared/run/types'
import type { SubagentScheduler } from './SubagentScheduler'

export interface CancelSubagentTreeResult {
  readonly requestedRunIds: readonly string[]
  readonly cancelledRunIds: readonly string[]
  readonly interruptedRunIds: readonly string[]
}

/**
 * lineage 驱动的取消/退出协调器。它不保存第二份运行状态，只把 SessionStore 的关系、
 * RunCoordinator 的状态与 RunExecutionRegistry 的句柄按一次生命周期操作组合起来。
 */
export class SubagentLifecycleCoordinator {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly runCoordinator: RunCoordinator,
    private readonly executionRegistry: RunExecutionRegistry,
    private readonly scheduler: SubagentScheduler
  ) {}

  listDescendantRunIds(parentRunId: string): string[] {
    const childRunIdsByParent = new Map<string, string[]>()
    for (const summary of this.sessionStore.listInternal()) {
      if (summary.kind !== 'subagent') continue
      const lineage = summary.subagent.lineage
      const children = childRunIdsByParent.get(lineage.parentRunId) ?? []
      children.push(lineage.spawnRunId)
      childRunIdsByParent.set(lineage.parentRunId, children)
    }
    const result: string[] = []
    const queue = [...(childRunIdsByParent.get(parentRunId) ?? [])]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const runId = queue.shift()!
      if (seen.has(runId)) continue
      seen.add(runId)
      result.push(runId)
      queue.push(...(childRunIdsByParent.get(runId) ?? []))
    }
    return result
  }

  async cancelRunTree(
    runId: string,
    reason: string,
    options: { readonly includeRoot?: boolean; readonly graceMs?: number } = {}
  ): Promise<CancelSubagentTreeResult> {
    const rootOwnerByRun = new Map<string, string>()
    for (const summary of this.sessionStore.listInternal()) {
      if (summary.kind === 'subagent') {
        rootOwnerByRun.set(summary.subagent.lineage.spawnRunId, summary.subagent.lineage.rootRunId)
      }
    }
    const candidates = [
      ...(options.includeRoot === false ? [] : [runId]),
      ...this.listDescendantRunIds(runId)
    ]
    const requested = candidates.filter((candidate) => {
      const snapshot = this.runCoordinator.getSnapshot(candidate)
      return snapshot !== null && !isTerminalRunStatus(snapshot.status)
    })

    for (const candidate of requested) {
      this.runCoordinator.beginCancel(candidate)
      this.runCoordinator.inbox.cancelAllForRun(candidate)
    }

    const abortResults = new Map<string, AbortResult>()
    await Promise.all(requested.map(async (candidate) => {
      const result = await this.executionRegistry.abort(candidate, reason, options.graceMs)
      abortResults.set(candidate, result)
    }))

    const cancelledRunIds: string[] = []
    const interruptedRunIds: string[] = []
    for (const candidate of requested) {
      const result = abortResults.get(candidate)
      const current = this.runCoordinator.getSnapshot(candidate)
      writerLeaseRegistry.release(candidate)
      const rootOwnerRunId = rootOwnerByRun.get(candidate)
      if (rootOwnerRunId) writerLeaseRegistry.release(rootOwnerRunId)
      if (!current || isTerminalRunStatus(current.status)) {
        if (current?.status === 'cancelled') cancelledRunIds.push(candidate)
        this.scheduler.releaseForRun(candidate)
        continue
      }
      if (!result || result.abortError || result.lingering) {
        this.runCoordinator.invalidateExecutionGeneration(candidate)
        this.runCoordinator.commitTerminal({
          runId: candidate,
          status: 'interrupted',
          reason: result?.abortError
            ? `${reason}:abort_error:${result.abortError}`
            : `${reason}:grace_expired`
        })
        interruptedRunIds.push(candidate)
      } else {
        this.runCoordinator.commitTerminal({ runId: candidate, status: 'cancelled', reason })
        cancelledRunIds.push(candidate)
      }
      this.scheduler.releaseForRun(candidate)
    }

    return { requestedRunIds: requested, cancelledRunIds, interruptedRunIds }
  }

  /** Electron 正常退出前同步落盘；真正的进程句柄由 OS 终止，重启后不会伪装为 running。 */
  interruptActiveChildrenOnShutdown(): RunSnapshot[] {
    const childSessionIds = new Set(
      this.sessionStore.listInternal()
        .filter((summary) => summary.kind === 'subagent')
        .map((summary) => summary.id)
    )
    const interrupted: RunSnapshot[] = []
    for (const snapshot of this.runCoordinator.listActiveRuns()) {
      if (!childSessionIds.has(snapshot.sessionId)) continue
      this.runCoordinator.invalidateExecutionGeneration(snapshot.runId)
      const committed = this.runCoordinator.commitTerminal({
        runId: snapshot.runId,
        status: 'interrupted',
        reason: 'process_exit'
      })
      if (committed) interrupted.push(committed)
      writerLeaseRegistry.release(snapshot.runId)
      this.scheduler.releaseForRun(snapshot.runId)
    }
    return interrupted
  }
}
