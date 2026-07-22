/**
 * RunExecutionRegistry — 活跃执行实例的进程内所有权登记。
 *
 * RunCoordinator 负责持久化状态，而本类保存实际可取消的执行句柄。
 * generation fencing：副作用入口必须用 isCurrent(runId, generation) 校验；
 * grace 超时后不得 unregister lingering handle，只能失效 generation。
 */
export interface RunExecutionHandle {
  runId: string
  generation: number
  kind: 'agent' | 'compose' | 'xforge'
  abort(reason: string): void
  settled: Promise<void>
}

export interface RunExecutionRegistryOptions {
  /** 等待执行自行收敛的最长时间；0 表示仅检查当前状态。 */
  graceMs?: number
}

export interface AbortResult {
  settled: boolean
  lingering: boolean
  /** abort() 自身抛错时仍返回，供调用方提交 interrupted */
  abortError?: string
  generation: number | null
}

export class RunExecutionRegistry {
  private readonly handles = new Map<string, RunExecutionHandle>()
  private readonly graceMs: number
  /** 已失效的 generation（grace 超时或显式 invalidate），副作用入口必须拒绝 */
  private readonly invalidated = new Map<string, Set<number>>()

  constructor(options: RunExecutionRegistryOptions = {}) {
    this.graceMs = options.graceMs ?? 5_000
  }

  /** 同一 runId 只保留最新 generation，避免旧执行覆盖新执行。 */
  register(handle: RunExecutionHandle): void {
    const current = this.handles.get(handle.runId)
    if (!current || handle.generation >= current.generation) {
      this.handles.set(handle.runId, handle)
      // 句柄真正 settled 后按匹配 generation 自动注销（含 grace 后 lingering）
      void handle.settled.then(
        () => {
          this.unregister(handle.runId, handle.generation)
        },
        () => {
          this.unregister(handle.runId, handle.generation)
        }
      )
    }
  }

  /**
   * 仅删除匹配 generation 的句柄；未传 generation 时用于已确认终态且已 settled 的强制清理。
   * lingering（未 settled）禁止无 generation 的盲删。
   */
  unregister(runId: string, generation?: number): boolean {
    const current = this.handles.get(runId)
    if (!current) return false
    if (generation !== undefined && current.generation !== generation) return false
    // 未传 generation 时：若仍未 settled，拒绝删除（防止 force-terminate grace 后误清）
    if (generation === undefined) {
      // 无法同步探测 Promise 状态；要求调用方传 generation，或仅在 settled 回调路径调用
      return false
    }
    this.handles.delete(runId)
    return true
  }

  get(runId: string): RunExecutionHandle | null {
    return this.handles.get(runId) ?? null
  }

  /**
   * 当前仍持有执行句柄的 runId 列表（即进程内有真实可取消执行的 run）。
   * 供入口锁结合 RunCoordinator 的 sessionId 做按会话的「未 settled」判断：
   * 句柄存在意味着执行尚未收敛，即便 durable snapshot 已短暂进入终态也不应放行新 turn。
   */
  listActiveRunIds(): string[] {
    return [...this.handles.keys()]
  }

  /** 是否仍有未 settled 的 agent 句柄（全局 AgentLoop 重叠防护） */
  hasUnsettledHandle(kind?: 'agent' | 'compose' | 'xforge'): boolean {
    for (const h of this.handles.values()) {
      if (kind && h.kind !== kind) continue
      return true
    }
    return false
  }

  /** 指定 run 的 generation 是否仍为当前且未被失效 */
  isCurrent(runId: string, generation: number): boolean {
    if (this.invalidated.get(runId)?.has(generation)) return false
    const h = this.handles.get(runId)
    if (!h) {
      // 句柄已注销且未显式失效 → 视为历史 generation，不再允许副作用
      return false
    }
    return h.generation === generation
  }

  /** 使 generation 失效；lingering handle 仍保留直至 settled */
  invalidateGeneration(runId: string, generation: number): void {
    let set = this.invalidated.get(runId)
    if (!set) {
      set = new Set()
      this.invalidated.set(runId, set)
    }
    set.add(generation)
  }

  /**
   * 发出取消信号并等待执行收敛。
   * 超出 grace：返回 lingering=true，**不** unregister；调用方应 invalidate generation。
   * abort() 抛错时仍返回，由调用方提交 interrupted，避免永久停在 cancelling。
   */
  async abort(
    runId: string,
    reason: string,
    graceMs = this.graceMs
  ): Promise<AbortResult> {
    const handle = this.handles.get(runId)
    if (!handle) {
      return { settled: true, lingering: false, generation: null }
    }

    let abortError: string | undefined
    try {
      handle.abort(reason)
    } catch (err) {
      abortError = err instanceof Error ? err.message : String(err)
    }

    const settled = await waitForSettlement(handle.settled, graceMs)
    if (!settled) {
      // grace 超时：失效 generation，但保留 handle 直至 settled 自动注销
      this.invalidateGeneration(runId, handle.generation)
    }
    return {
      settled,
      lingering: !settled,
      abortError,
      generation: handle.generation
    }
  }
}

/**
 * 等待 settled，并在超时或完成后清理 timer，避免 settled 后 timer 残留。
 */
export async function waitForSettlement(
  settled: Promise<void>,
  graceMs: number
): Promise<boolean> {
  if (graceMs <= 0) {
    return Promise.race([
      settled.then(() => true),
      Promise.resolve(false)
    ])
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      settled.then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), graceMs)
      })
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}
