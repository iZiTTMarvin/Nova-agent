/**
 * 单次编排 run 的状态机：running → completed / failed / cancelled。
 *
 * 无暂停态。阶段 agent 调 askQuestion 时阻塞发生在工具执行内部，run 状态仍是 running；
 * 因此 run 的整个生命周期就是一条 await 链，不需要 resume 状态或外部驱动。
 *
 * 终态语义固定为 scope.close → abort 子 agent → grace 内等待收敛 → 回收 worktree：
 * grace 结束仍有存活子任务时必须跳过回收，否则会删掉仍被占用的目录。
 */
import * as Worktree from '../../worktree'
import { createHostFns, releaseWorktree, type HostContext } from '../host'
import { TaskScope, type TaskScopeReason } from '../scheduling/TaskScope'
import { loadJournal } from '../state/journal'
import { writeWorkflowRunMetadata } from '../state/runMetadata'
import type { WorkflowDefinition, WorkflowResult } from '../definitions/types'
import type {
  StartWorkflowOptions,
  WorkflowRunOutcome,
  WorkflowRunSnapshot,
  WorkflowRunStatus
} from './types'

/** 默认墙钟预算：编排是小时级任务，但必须有上界，否则 scope 永不 abort */
const DEFAULT_DEADLINE_MS = 12 * 60 * 60 * 1000

export class WorkflowRun {
  readonly runId: string
  readonly workflow: string
  readonly sessionId: string

  private readonly definition: WorkflowDefinition
  private readonly options: StartWorkflowOptions
  private readonly scope: TaskScope
  private readonly ctx: HostContext
  private readonly startedAt: string

  private status: WorkflowRunStatus = 'running'
  private phase: string
  private updatedAt: string
  private error?: string
  /** 外部显式请求取消：用于区分「用户中断」与「deadline / 失败」 */
  private cancelRequested = false
  private startPromise: Promise<WorkflowRunOutcome> | undefined
  private readonly detachAbort: (() => void) | null

  constructor(
    runId: string,
    definition: WorkflowDefinition,
    options: StartWorkflowOptions
  ) {
    this.runId = runId
    this.definition = definition
    this.options = options
    this.workflow = definition.name
    this.sessionId = options.host.sessionId
    this.startedAt = new Date().toISOString()
    this.updatedAt = this.startedAt
    this.phase = options.startStage

    this.scope = new TaskScope({
      label: `workflow:${definition.name}:${runId}`,
      deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {})
    })

    const host = options.host

    this.ctx = {
      runId,
      workspaceRoot: host.workspaceRoot,
      sessionId: host.sessionId,
      parentRunId: host.parentRunId,
      parentMessageId: host.parentMessageId,
      parentToolCallId: host.parentToolCallId,
      spawnSubagentPort: host.spawnSubagentPort,
      scope: this.scope,
      scopeGeneration: this.scope.captureGeneration(),
      abortSignal: this.scope.signal,
      eventBus: host.eventBus,
      ...(host.checkpointManager ? { checkpointManager: host.checkpointManager } : {}),
      ...(host.supportsVision !== undefined ? { supportsVision: host.supportsVision } : {}),
      mode: host.mode ?? 'compose',
      autoMode: options.autoMode ?? false,
      // resume 时命中缓存的 agent() 调用直接返回已有结果，不再 spawn
      journal: loadJournal(host.workspaceRoot, runId),
      occ: new Map(),
      ownedWorktrees: new Map(),
      worktreeKeys: new Map(),
      currentPhase: { name: options.startStage },
      ...(host.assertExecutionCurrent
        ? { assertExecutionCurrent: host.assertExecutionCurrent }
        : {})
    }

    // 外部信号（停止按钮 / 父 turn abort）必须能穿透到 TaskScope.close，
    // 否则子 agent 与 worktree 都不会被回收。
    const external = options.abortSignal
    let detach: (() => void) | null = null
    if (external?.aborted) {
      this.cancelRequested = true
    } else if (external) {
      const onAbort = (): void => {
        void this.cancel()
      }
      external.addEventListener('abort', onAbort, { once: true })
      detach = () => external.removeEventListener('abort', onAbort)
    }
    this.detachAbort = detach
  }

  snapshot(): WorkflowRunSnapshot {
    return {
      runId: this.runId,
      workflow: this.workflow,
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      status: this.status,
      // phase 的写入方是 host.progress；快照时读取当前值，避免维护第二份阶段状态
      phase: this.ctx.currentPhase.name || this.phase,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      ...(this.error !== undefined ? { error: this.error } : {})
    }
  }

  get isTerminal(): boolean {
    return this.status !== 'running'
  }

  /** 幂等：重复调用返回同一个 outcome promise */
  start(): Promise<WorkflowRunOutcome> {
    this.startPromise ??= this.runOnce()
    return this.startPromise
  }

  /**
   * 请求取消。等待终态收尾完成后返回，调用方据此确认 worktree 已按契约处理。
   * run 尚未 start 时也可调用：scope 立即关闭，后续 start 会直接走 cancelled 分支。
   */
  async cancel(): Promise<void> {
    this.cancelRequested = true
    if (this.startPromise) {
      await this.scope.close('cancelled')
      await this.startPromise
      return
    }
    await this.finalize('cancelled')
  }

  private async runOnce(): Promise<WorkflowRunOutcome> {
    this.persistMetadata()
    this.emitRunState()

    if (this.cancelRequested) {
      await this.finalize('cancelled')
      return { status: 'cancelled', runId: this.runId }
    }

    let result: WorkflowResult | null = null
    let thrown: unknown = null
    try {
      result = await this.scope.spawn(
        (signal) =>
          this.definition.run({
            host: createHostFns(this.ctx),
            request: this.options.request,
            startStage: this.options.startStage,
            injectedContext: this.options.injectedContext ?? {},
            abortSignal: signal,
            autoMode: this.options.autoMode ?? false
          }),
        { label: `workflow-run:${this.workflow}` }
      )
    } catch (err) {
      thrown = err
    }

    // scope 已 abort（取消 / deadline / 父级关闭）时，definition 的返回值不再可信
    const scopeReason = this.scope.reason
    if (this.cancelRequested || scopeReason === 'cancelled' || scopeReason === 'parent_closed') {
      await this.finalize('cancelled')
      return { status: 'cancelled', runId: this.runId }
    }
    if (scopeReason === 'deadline') {
      const message = '编排超出墙钟预算'
      await this.finalize('deadline', message)
      return { status: 'failed', runId: this.runId, error: message }
    }
    if (thrown !== null) {
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      await this.finalize('failed', message)
      return { status: 'failed', runId: this.runId, error: message }
    }
    if (!result || result.status === 'failed') {
      const message = result?.reason ?? 'workflow 未产出结果'
      await this.finalize('failed', message)
      return { status: 'failed', runId: this.runId, error: message }
    }

    await this.finalize('completed')
    return {
      status: 'completed',
      runId: this.runId,
      summary: result.summary ?? `${this.workflow} 编排完成`,
      ...(result.result !== undefined ? { result: result.result } : {})
    }
  }

  /**
   * 终态收尾：只允许执行一次。
   * 顺序不可调换 —— 必须先 close（abort 子 agent 并等 grace），再按收敛结果决定是否回收目录。
   */
  private async finalize(reason: TaskScopeReason, error?: string): Promise<void> {
    if (this.isTerminal) return
    this.status =
      reason === 'completed'
        ? 'completed'
        : reason === 'cancelled' || reason === 'parent_closed'
          ? 'cancelled'
          : 'failed'
    if (error !== undefined) this.error = error
    this.phase = this.ctx.currentPhase.name || this.phase
    this.updatedAt = new Date().toISOString()

    const closeResult = await this.scope.close(reason)
    this.detachAbort?.()
    await this.reclaimWorktrees(closeResult.settled)
    this.updatedAt = new Date().toISOString()
    this.persistMetadata()
    this.emitRunState()
  }

  /** 元数据只记录 resume 校验和诊断所需的快照，不复制阶段产物。 */
  private persistMetadata(): void {
    const snapshot = this.snapshot()
    try {
      writeWorkflowRunMetadata(this.ctx.workspaceRoot, {
        version: 2,
        runId: snapshot.runId,
        workflow: snapshot.workflow,
        sessionId: this.ctx.sessionId,
        parentRunId: this.ctx.parentRunId,
        parentMessageId: this.ctx.parentMessageId,
        parentToolCallId: this.ctx.parentToolCallId,
        status: snapshot.status,
        phase: snapshot.phase,
        startedAt: snapshot.startedAt,
        updatedAt: snapshot.updatedAt,
        ...(snapshot.error !== undefined ? { error: snapshot.error } : {})
      })
    } catch (error) {
      console.warn(
        `[workflow] run metadata 写入失败：${snapshot.runId}`,
        error instanceof Error ? error.message : error
      )
    }
  }

  /**
   * worktree 生命周期收尾。
   *
   * - grace 内未收敛（仍有子进程持有目录）→ 一个都不动，交给下次启动或用户处理；
   * - 成功且有改动 → 保留，等 integrate；
   * - 成功但 pristine、或失败 / 取消 → 删除。
   */
  private async reclaimWorktrees(settled: boolean): Promise<void> {
    if (!settled) return
    const owned = [...this.ctx.ownedWorktrees.entries()]
    for (const [directory, entry] of owned) {
      if (this.status === 'completed') {
        const pristine = await Worktree.isPristine(directory, entry.baseSha).catch(() => false)
        if (!pristine) continue
      }
      await releaseWorktree(this.ctx, directory)
    }
  }

  /** 向 renderer 广播 run 状态，供输入框进入 / 退出运行态 */
  private emitRunState(): void {
    const snap = this.snapshot()
    this.ctx.eventBus.emit({
      type: 'workflow_run_state',
      runId: snap.runId,
      ...(snap.sessionId !== undefined ? { sessionId: snap.sessionId } : {}),
      workflow: snap.workflow,
      status: snap.status,
      phase: snap.phase,
      ...(snap.error !== undefined ? { error: snap.error } : {})
    })
  }
}
