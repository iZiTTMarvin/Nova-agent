import type { RunCoordinator } from '../run/RunCoordinator'
import type { AbortResult, RunExecutionRegistry } from '../run/RunExecutionRegistry'
import type { SessionStore } from '../sessions/SessionStore'
import type { SessionControlIntent } from '../sessions/types'
import { writerLeaseRegistry } from '../workspace'
import { isTerminalRunStatus, type RunSnapshot } from '../../shared/run/types'
import type { SubagentScheduler } from './SubagentScheduler'

export interface CancelSubagentTreeResult {
  readonly requestedRunIds: readonly string[]
  readonly cancelledRunIds: readonly string[]
  readonly interruptedRunIds: readonly string[]
}

export interface ControlIntentReplayResult {
  readonly replayedOperationIds: readonly string[]
  readonly retained: ReadonlyArray<{ sessionId: string; operationId: string; reason: string }>
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

  getRootRunId(runId: string): string {
    const child = this.sessionStore.listInternal().find(session =>
      session.kind === 'subagent' && session.subagent.lineage.spawnRunId === runId)
    return child?.kind === 'subagent' ? child.subagent.lineage.rootRunId : runId
  }

  /**
   * 范围查询按 per-run 派遣关联（dispatch）优先，覆盖 followup 与前一父轮后台任务：
   * followup 的新 run 归属新父轮，不得再挂回出生父 run。旧记录回退出生 lineage。
   */
  listDescendantRunIds(parentRunId: string): string[] {
    const childRunIdsByParent = new Map<string, string[]>()
    const addEdge = (parent: string, child: string): void => {
      const children = childRunIdsByParent.get(parent) ?? []
      children.push(child)
      childRunIdsByParent.set(parent, children)
    }
    const dispatchedRunIds = new Set<string>()
    for (const snapshot of this.runCoordinator.listDispatchSnapshots()) {
      const dispatch = snapshot.dispatch
      if (!dispatch) continue
      addEdge(dispatch.parentRunId, snapshot.runId)
      dispatchedRunIds.add(snapshot.runId)
    }
    for (const summary of this.sessionStore.listInternal()) {
      if (summary.kind !== 'subagent') continue
      const lineage = summary.subagent.lineage
      // 新协议 run 的权威关联是 dispatch，不再回退出生 lineage
      if (dispatchedRunIds.has(lineage.spawnRunId)) continue
      addEdge(lineage.parentRunId, lineage.spawnRunId)
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
    return this.cancelRuns([
      ...(options.includeRoot === false ? [] : [runId]),
      ...this.listDescendantRunIds(runId)
    ], reason, options.graceMs)
  }

  private async cancelRuns(
    candidates: readonly string[],
    reason: string,
    graceMs?: number
  ): Promise<CancelSubagentTreeResult> {
    const rootOwnerByRun = new Map<string, string>()
    for (const summary of this.sessionStore.listInternal()) {
      if (summary.kind === 'subagent') {
        rootOwnerByRun.set(summary.subagent.lineage.spawnRunId, summary.subagent.lineage.rootRunId)
      }
    }
    const errors: unknown[] = []
    const requested = [...new Set(candidates)].filter((candidate) => {
      try {
        const snapshot = this.runCoordinator.getSnapshot(candidate)
        return snapshot !== null && !isTerminalRunStatus(snapshot.status)
      } catch (error) {
        errors.push(error)
        return true
      }
    })

    // 持久化失败不能阻止其他目标收到取消；全部尝试后统一报告失败并保留意图。
    for (const candidate of requested) {
      try {
        this.runCoordinator.beginCancel(candidate)
        this.runCoordinator.inbox.cancelAllForRun(candidate)
      } catch (error) {
        errors.push(error)
      }
    }

    const abortResults = new Map<string, AbortResult>()
    await Promise.all(requested.map(async (candidate) => {
      try {
        const result = await this.executionRegistry.abort(candidate, reason, graceMs)
        abortResults.set(candidate, result)
      } catch (error) {
        errors.push(error)
      }
    }))

    const cancelledRunIds: string[] = []
    const interruptedRunIds: string[] = []
    for (const candidate of requested) {
      try {
        const result = abortResults.get(candidate)
        const current = this.runCoordinator.getSnapshot(candidate)
        writerLeaseRegistry.release(candidate)
        const rootOwnerRunId = rootOwnerByRun.get(candidate)
        if (rootOwnerRunId && current && current.dispatch?.execution !== 'background_read_only') {
          writerLeaseRegistry.release(rootOwnerRunId)
        }
        if (!current || isTerminalRunStatus(current.status)) {
          if (current?.status === 'cancelled') cancelledRunIds.push(candidate)
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
      } catch (error) {
        errors.push(error)
      } finally {
        this.scheduler.releaseForRun(candidate)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, '取消执行未完整收敛，请重试')
    return { requestedRunIds: requested, cancelledRunIds, interruptedRunIds }
  }

  /**
   * 启动重放未完成控制意图（必须先于 run 对账与通知扫描执行，且要求
   * RunCoordinator 已先收敛尾部事件）：stop→按冻结目标收敛取消并失效化
   * 投递绑定；branch_invalidate→补完投递失效化；delete→先收敛目标 run，
   * 再删 run，会话目录子先父后（父元数据最后移除）。
   * 按 operationId 与冻结目标幂等；任一步失败保留意图并如实上报，不假装已停止。
   */
  async replayControlIntents(): Promise<ControlIntentReplayResult> {
    const replayed: string[] = []
    const retained: Array<{ sessionId: string; operationId: string; reason: string }> = []
    for (const { sessionId, intent } of this.sessionStore.listControlIntents()) {
      try {
        await this.applyControlIntent(intent)
        if (!this.sessionStore.clearControlIntent(sessionId, intent.operationId)) {
          throw new Error('控制意图未清除，请重试')
        }
        replayed.push(intent.operationId)
      } catch (err) {
        retained.push({
          sessionId,
          operationId: intent.operationId,
          reason: err instanceof Error ? err.message : String(err)
        })
      }
    }
    return { replayedOperationIds: replayed, retained }
  }

  /**
   * 用户停止链路（进程内取消的持久入口）：冻结目标 → 先提交持久意图 →
   * 逐项收敛（取消非终态、失效化投递源绑定）→ 全部提交后清除意图。
   * 处理途中崩溃由启动重放按同一冻结目标补完；意图提交失败不假装已持久停止：
   * 尽力取消并如实抛错；同会话已有不同意图时拒绝新操作，不扩张冻结目标。
   */
  async stopRunTree(runId: string, reason: string): Promise<CancelSubagentTreeResult> {
    const root = this.runCoordinator.getSnapshot(runId)
    if (!root) throw new Error(`停止目标 run ${runId} 不存在`)
    const intent: SessionControlIntent = {
      version: 1,
      kind: 'stop',
      operationId: `stop:${runId}`,
      targetRunIds: [runId, ...this.listDescendantRunIds(runId)],
      targetSessionIds: [],
      requestedAt: Date.now()
    }
    let committed: ReturnType<SessionStore['setControlIntent']>
    try {
      committed = this.sessionStore.setControlIntent(root.sessionId, intent)
    } catch (error) {
      try {
        await this.cancelRuns(intent.targetRunIds, reason)
      } catch (cancelError) {
        throw new AggregateError([error, cancelError], '停止未持久化且取消未完整收敛，请重试')
      }
      throw error
    }
    if (!committed.ok) {
      if (committed.code === 'conflict') {
        throw new Error('已有未完成的控制意图，不能执行新的停止目标，请先重试原操作')
      }
      await this.cancelRuns(intent.targetRunIds, reason)
      throw new Error(`停止意图宿主会话 ${root.sessionId} 不存在，停止未持久化`)
    }
    const result = await this.processStopTargets(intent, reason)
    if (!this.sessionStore.clearControlIntent(root.sessionId, intent.operationId)) {
      throw new Error('停止意图未清除，请重试')
    }
    return result
  }

  /**
   * 停止意图逐项收敛。先写投递源（带 dispatch 目标）的失效化记录，再 abort/join
   * 非终态目标：崩溃窗口内意图重放仍能按冻结目标补完，已终态目标自动跳过取消=幂等。
   */
  private async processStopTargets(
    intent: SessionControlIntent,
    cancelReason: string
  ): Promise<CancelSubagentTreeResult> {
    const invalidatedReason = `control_intent:${intent.operationId}`
    const errors: unknown[] = []
    for (const target of intent.targetRunIds) {
      try {
        const snapshot = this.runCoordinator.getSnapshot(target)
        if (snapshot?.dispatch) {
          this.runCoordinator.updateDeliveryBinding(target, { invalidatedReason })
        }
      } catch (error) {
        errors.push(error)
      }
    }
    let result: CancelSubagentTreeResult | undefined
    try {
      result = await this.cancelRuns(intent.targetRunIds, cancelReason)
    } catch (error) {
      errors.push(error)
    }
    if (!result || errors.length > 0) {
      throw new AggregateError(errors, '停止目标未完整持久化，控制意图已保留，请重试')
    }
    return result
  }

  private async applyControlIntent(intent: SessionControlIntent): Promise<void> {
    const reason = `control_intent:${intent.operationId}`
    switch (intent.kind) {
      case 'stop':
        // 终态目标自动被过滤=幂等；启动无活句柄时崩溃残留 running 收敛为 cancelled；
        // 已终态投递源补写绑定失效化，停止覆盖的完成通知不得唤醒父级
        await this.processStopTargets(intent, reason)
        return
      case 'branch_invalidate':
        for (const runId of intent.targetRunIds) {
          this.runCoordinator.updateDeliveryBinding(runId, {
            invalidatedReason: `branch_invalidate:${intent.operationId}`
          })
        }
        return
      case 'delete': {
        const targetSessions = new Set(intent.targetSessionIds)
        const pending = new Set<string>()
        for (const snapshot of this.runCoordinator.listSnapshotsForSessions(targetSessions)) {
          if (!isTerminalRunStatus(snapshot.status)) pending.add(snapshot.runId)
        }
        for (const runId of intent.targetRunIds) {
          const snapshot = this.runCoordinator.getSnapshot(runId)
          if (snapshot && !isTerminalRunStatus(snapshot.status)) pending.add(runId)
        }
        for (const runId of pending) {
          await this.cancelRunTree(runId, reason)
        }
        // 门禁会再验终态：未收敛则抛错，意图保留待下次重放
        this.runCoordinator.deleteRunsForSessions(targetSessions)
        // 会话目录子先父后：按 lineage 深度降序删除，父元数据（含意图）最后移除
        const depthBySession = new Map<string, number>()
        for (const summary of this.sessionStore.listInternal()) {
          depthBySession.set(
            summary.id,
            summary.kind === 'subagent' ? summary.subagent.lineage.depth : -1
          )
        }
        const ordered = [...intent.targetSessionIds].sort(
          (a, b) => (depthBySession.get(b) ?? -1) - (depthBySession.get(a) ?? -1)
        )
        for (const sessionId of ordered) {
          this.sessionStore.delete(sessionId)
        }
        return
      }
    }
  }

  /** Electron 正常退出前同步落盘；真正的进程句柄由 OS 终止，重启后不会伪装为 running。 */
  interruptActiveChildrenOnShutdown(): RunSnapshot[] {
    const childSessionIds = new Set(
      this.sessionStore.listInternal()
        .filter((summary) => summary.kind === 'subagent')
        .map((summary) => summary.id)
    )
    const rootOwnerByRun = new Map<string, string>()
    for (const summary of this.sessionStore.listInternal()) {
      if (summary.kind === 'subagent') {
        rootOwnerByRun.set(
          summary.subagent.lineage.spawnRunId,
          summary.subagent.lineage.rootRunId
        )
      }
    }
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
      const rootOwnerRunId = rootOwnerByRun.get(snapshot.runId)
      if (
        rootOwnerRunId &&
        snapshot.dispatch?.execution !== 'background_read_only'
      ) {
        writerLeaseRegistry.release(rootOwnerRunId)
      }
      this.scheduler.releaseForRun(snapshot.runId)
    }
    return interrupted
  }
}
