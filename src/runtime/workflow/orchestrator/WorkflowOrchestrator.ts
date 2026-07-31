/**
 * 编排控制器：workflow run 生命周期与状态的唯一 Owner。
 *
 * 对外只暴露 start / cancel / getStatus 及按会话的查询。调用方（start_workflow 工具、
 * 入口互斥判断、停止按钮）都必须经这里读状态，不得自行缓存一份 run 状态。
 */
import { generateRunId } from '../state/paths'
import { isSafeWorkflowRunId, readWorkflowRunMetadata } from '../state/runMetadata'
import { WorkflowRun } from './WorkflowRun'
import type {
  StartWorkflowOptions,
  WorkflowOrchestratorDeps,
  WorkflowRunOutcome,
  WorkflowRunSnapshot
} from './types'

export class WorkflowOrchestrator {
  private readonly deps: WorkflowOrchestratorDeps
  /** runId → run。终态 run 保留在表内供 getStatus 查询，直到被同 id 覆盖或显式忘记 */
  private readonly runs = new Map<string, WorkflowRun>()

  constructor(deps: WorkflowOrchestratorDeps) {
    this.deps = deps
  }

  /**
   * 启动一条 workflow 并等待其到达终态。
   *
   * 阻塞语义是刻意的：start_workflow 工具在 AgentLoop 内 await 本方法，
   * 由此让「编排运行中」与「turn 进行中」天然同生命周期，入口互斥不需要额外状态。
   */
  async start(options: StartWorkflowOptions): Promise<WorkflowRunOutcome> {
    const definition = this.deps.resolveDefinition(options.workflow)
    if (!definition) {
      return {
        status: 'failed',
        runId: options.runId ?? '',
        error: `未知 workflow: ${options.workflow}`
      }
    }
    if (!definition.stages.includes(options.startStage)) {
      return {
        status: 'failed',
        runId: options.runId ?? '',
        error: `workflow ${definition.name} 不存在起始阶段 ${options.startStage}`
      }
    }

    if (options.runId) {
      const existing = this.runs.get(options.runId)
      if (existing && !existing.isTerminal) {
        return {
          status: 'failed',
          runId: options.runId,
          error: `workflow run ${options.runId} 仍在运行，不能重复启动`
        }
      }
      if (!isSafeWorkflowRunId(options.runId)) {
        return {
          status: 'failed',
          runId: options.runId,
          error: 'workflow runId 非法'
        }
      }
      const metadata = readWorkflowRunMetadata(options.host.workspaceRoot, options.runId)
      if (!metadata) {
        return {
          status: 'failed',
          runId: options.runId,
          error: `找不到可恢复的 workflow run 元数据：${options.runId}`
        }
      }
      if (metadata.workflow !== definition.name) {
        return {
          status: 'failed',
          runId: options.runId,
          error: `workflow run ${options.runId} 属于 ${metadata.workflow}，不能按 ${definition.name} 恢复`
        }
      }
      if (metadata.status === 'completed') {
        return {
          status: 'failed',
          runId: options.runId,
          error: `workflow run ${options.runId} 已完成，不能按 resume 重复启动`
        }
      }
    }

    const runId = this.allocateRunId(options.runId)
    const run = new WorkflowRun(runId, definition, options)
    this.runs.set(runId, run)
    return run.start()
  }

  /**
   * 取消指定 run；返回 false 表示 run 不存在或已是终态。
   * 等待返回后 TaskScope 已关闭且 worktree 已按生命周期契约处理。
   */
  async cancel(runId: string): Promise<boolean> {
    const run = this.runs.get(runId)
    if (!run || run.isTerminal) return false
    await run.cancel()
    return true
  }

  /**
   * 取消某会话下所有仍在跑的 run（停止按钮入口）。
   * 返回被取消的 runId 列表。
   */
  async cancelForSession(sessionId: string): Promise<string[]> {
    const targets = [...this.runs.values()].filter(
      (run) => run.sessionId === sessionId && !run.isTerminal
    )
    const cancelled: string[] = []
    for (const run of targets) {
      await run.cancel()
      cancelled.push(run.runId)
    }
    return cancelled
  }

  getStatus(runId: string): WorkflowRunSnapshot | null {
    return this.runs.get(runId)?.snapshot() ?? null
  }

  /** 该会话当前是否有运行中的编排；有则返回其快照。入口互斥的唯一判据。 */
  getActiveRunForSession(sessionId: string): WorkflowRunSnapshot | null {
    for (const run of this.runs.values()) {
      if (run.sessionId === sessionId && !run.isTerminal) return run.snapshot()
    }
    return null
  }

  listActiveRuns(): WorkflowRunSnapshot[] {
    return [...this.runs.values()]
      .filter((run) => !run.isTerminal)
      .map((run) => run.snapshot())
  }

  /** 移除已终态 run 的内存记录（会话删除 / 长期驻留进程回收用） */
  forget(runId: string): boolean {
    const run = this.runs.get(runId)
    if (!run || !run.isTerminal) return false
    return this.runs.delete(runId)
  }

  /**
   * 分配 runId。
   * 显式传入即视为 resume（沿用其 journal）；自动生成时按秒粒度去重，
   * 同秒内启动的第二条 run 追加后缀，避免两条 run 共用 journal 目录。
   */
  private allocateRunId(explicit?: string): string {
    if (explicit) return explicit
    const base = generateRunId()
    if (!this.runs.has(base)) return base
    let suffix = 2
    while (this.runs.has(`${base}-${suffix}`)) suffix += 1
    return `${base}-${suffix}`
  }
}
