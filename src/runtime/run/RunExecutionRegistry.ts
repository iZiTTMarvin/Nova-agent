/**
 * RunExecutionRegistry — 活跃执行实例的进程内所有权登记。
 *
 * RunCoordinator 负责持久化状态，而本类保存实际可取消的执行句柄。
 * 因此只有执行确实结束后，调用方才能把 run 提交为 cancelled。
 */
export interface RunExecutionHandle {
  runId: string
  generation: number
  kind: 'agent' | 'compose'
  abort(reason: string): void
  settled: Promise<void>
}

export interface RunExecutionRegistryOptions {
  /** 等待执行自行收敛的最长时间；0 表示仅检查当前状态。 */
  graceMs?: number
}

export class RunExecutionRegistry {
  private readonly handles = new Map<string, RunExecutionHandle>()
  private readonly graceMs: number

  constructor(options: RunExecutionRegistryOptions = {}) {
    this.graceMs = options.graceMs ?? 5_000
  }

  /** 同一 runId 只保留最新 generation，避免旧执行覆盖新执行。 */
  register(handle: RunExecutionHandle): void {
    const current = this.handles.get(handle.runId)
    if (!current || handle.generation >= current.generation) {
      this.handles.set(handle.runId, handle)
    }
  }

  /**
   * 仅删除匹配 generation 的句柄；未传 generation 时用于已确认终态的强制清理。
   */
  unregister(runId: string, generation?: number): boolean {
    const current = this.handles.get(runId)
    if (!current || (generation !== undefined && current.generation !== generation)) return false
    this.handles.delete(runId)
    return true
  }

  get(runId: string): RunExecutionHandle | null {
    return this.handles.get(runId) ?? null
  }

  /**
   * 发出取消信号并等待执行收敛。超出 grace 时保留句柄，供后续诊断或再次终止。
   */
  async abort(
    runId: string,
    reason: string,
    graceMs = this.graceMs
  ): Promise<{ settled: boolean; lingering: boolean }> {
    const handle = this.handles.get(runId)
    if (!handle) return { settled: true, lingering: false }

    handle.abort(reason)
    const settled = await waitForSettlement(handle.settled, graceMs)
    return { settled, lingering: !settled }
  }
}

async function waitForSettlement(settled: Promise<void>, graceMs: number): Promise<boolean> {
  if (graceMs <= 0) {
    return Promise.race([
      settled.then(() => true),
      Promise.resolve(false)
    ])
  }

  return Promise.race([
    settled.then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), graceMs))
  ])
}
