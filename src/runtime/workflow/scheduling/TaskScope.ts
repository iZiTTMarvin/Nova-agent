/**
 * TaskScope：结构化并发所有者。
 * 根 AbortController + child 注册；terminal 时原子关闭 → abort → grace 内 allSettled → finalize。
 * host hook 提交副作用前必须检查 generation，旧 continuation 无权写入。
 */
export type TaskScopeReason =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'deadline'
  | 'parent_closed'

export interface TaskScopeOptions {
  /** 父 scope；子 scope 随父 abort 一起关闭 */
  parent?: TaskScope
  /** 可选标签（诊断用） */
  label?: string
  /** 墙钟 deadline（ms）；到期真正 abort，不只 Promise.race */
  deadlineMs?: number
  /** 关闭后等待 child 收敛的宽限期，默认 5s */
  graceMs?: number
}

export interface SpawnOptions {
  label?: string
  /** 忽略父已关闭时抛错，直接返回（用于清理路径） */
  ignoreIfClosed?: boolean
}

export interface TaskScopeCloseResult {
  /** 宽限期内是否确认所有真实任务均已退出 */
  settled: boolean
  /** 宽限期结束时仍在运行的真实任务 */
  lingeringTaskIds: string[]
}

interface ScopedTask {
  id: string
  /** 给调用方的快速失败视图；abort 后无需等待底层任务退出 */
  visiblePromise: Promise<unknown>
  /** fn 的真实生命周期；资源清理必须以此为准 */
  actualPromise: Promise<unknown>
}

const DEFAULT_GRACE_MS = 5_000

let nextScopeId = 1

/**
 * 结构化并发 scope。
 * - spawn：注册 child Promise，随 scope abort
 * - child：创建嵌套 scope（parallel/pipeline 用）
 * - close：原子关闭，禁止新任务，abort 全部 child，grace 内 allSettled
 */
export class TaskScope {
  readonly id: number
  readonly label: string
  /** 每次 close 递增；host hook 用此判断 continuation 是否仍有效 */
  private _generation = 0
  private readonly controller = new AbortController()
  private readonly tasks = new Map<string, ScopedTask>()
  private readonly childScopes = new Set<TaskScope>()
  private closed = false
  private closeReason: TaskScopeReason | null = null
  /** 最近一次关闭的真实收敛结果，供诊断与资源回收决策使用 */
  lastCloseResult: TaskScopeCloseResult | undefined
  private closePromise: Promise<TaskScopeCloseResult> | undefined
  private nextTaskId = 1
  private readonly graceMs: number
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined
  private readonly parent: TaskScope | null
  private readonly onParentAbort: (() => void) | null

  constructor(opts: TaskScopeOptions = {}) {
    this.id = nextScopeId++
    this.label = opts.label ?? `scope-${this.id}`
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
    this.parent = opts.parent ?? null

    if (opts.deadlineMs != null && opts.deadlineMs > 0) {
      this.deadlineTimer = setTimeout(() => {
        void this.close('deadline')
      }, opts.deadlineMs)
    }

    if (this.parent) {
      this.onParentAbort = () => {
        void this.close('parent_closed')
      }
      if (this.parent.signal.aborted) {
        void this.close('parent_closed')
      } else {
        this.parent.signal.addEventListener('abort', this.onParentAbort, { once: true })
      }
      this.parent.childScopes.add(this)
    } else {
      this.onParentAbort = null
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get generation(): number {
    return this._generation
  }

  get isClosed(): boolean {
    return this.closed
  }

  get reason(): TaskScopeReason | null {
    return this.closeReason
  }

  /**
   * 副作用提交前检查：scope 未关闭且 generation 仍匹配。
   * 旧 continuation 在 close 后 generation 已变，返回 false。
   */
  isCurrent(expectedGeneration: number): boolean {
    return !this.closed && this._generation === expectedGeneration
  }

  /** 捕获当前 generation，供异步回调校验 */
  captureGeneration(): number {
    return this._generation
  }

  /**
   * 注册并运行 child 任务。scope 已关闭时抛错（除非 ignoreIfClosed）。
   * 运行中若 scope abort，Promise 以 aborted 拒绝（真正取消语义）。
   */
  spawn<T>(fn: (signal: AbortSignal) => Promise<T> | T, opts: SpawnOptions = {}): Promise<T> {
    if (this.closed) {
      if (opts.ignoreIfClosed) {
        return Promise.reject(new Error(`TaskScope closed: ${this.closeReason}`))
      }
      throw new Error(`TaskScope closed (${this.closeReason ?? 'unknown'}): cannot spawn ${opts.label ?? 'task'}`)
    }

    const gen = this._generation
    const signal = this.signal
    const taskId = `${this.id}:${this.nextTaskId++}`
    const abortedError = (): Error => new Error(`TaskScope aborted: ${this.closeReason ?? 'aborted'}`)

    // spawn 成功即代表任务已交给运行时。即使 abort 先于微任务调度发生，
    // 也要追踪 fn 的真实退出，避免把已启动的底层操作误当作不存在。
    const actualPromise = Promise.resolve().then(() => fn(signal))

    const visiblePromise = new Promise<T>((resolve, reject) => {
      if (!this.isCurrent(gen) || signal.aborted) {
        reject(abortedError())
        return
      }

      const onAbort = (): void => reject(abortedError())
      signal.addEventListener('abort', onAbort, { once: true })
      actualPromise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          if (!this.isCurrent(gen) || signal.aborted) {
            reject(abortedError())
            return
          }
          resolve(value as T)
        },
        (err) => {
          signal.removeEventListener('abort', onAbort)
          reject(err)
        }
      )
    })

    const task: ScopedTask = { id: taskId, visiblePromise, actualPromise }
    this.tasks.set(taskId, task)
    // 用 then 而非 finally，避免 cleanup 分支本身形成未处理的拒绝 Promise。
    actualPromise.then(
      () => this.tasks.delete(taskId),
      () => this.tasks.delete(taskId)
    )
    actualPromise.catch(() => undefined)
    visiblePromise.catch(() => undefined)
    return visiblePromise
  }

  /** 创建子 scope（parallel / pipeline 分支） */
  child(label?: string, deadlineMs?: number): TaskScope {
    if (this.closed) {
      throw new Error(`TaskScope closed: cannot create child`)
    }
    return new TaskScope({
      parent: this,
      label: label ?? `${this.label}/child`,
      deadlineMs,
      graceMs: this.graceMs
    })
  }

  /**
   * 原子关闭 scope：
   * 1. 标记 closed + 递增 generation（旧 continuation 失效）
   * 2. abort 信号 + 递归关闭 child scopes
   * 3. grace 内 allSettled 等待已注册 child
   */
  close(reason: TaskScopeReason = 'cancelled'): Promise<TaskScopeCloseResult> {
    if (this.closePromise) return this.closePromise
    this.closePromise = this.closeOnce(reason)
    return this.closePromise
  }

  private async closeOnce(reason: TaskScopeReason): Promise<TaskScopeCloseResult> {
    this.closed = true
    this.closeReason = reason
    this._generation += 1

    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer)
      this.deadlineTimer = undefined
    }

    if (!this.controller.signal.aborted) {
      this.controller.abort(reason)
    }

    // 先关子 scope，再等本层 child
    const childScopes = [...this.childScopes]
    const childClose = childScopes.map((s) => s.close(reason))
    await Promise.allSettled(childClose)

    const settled = await this.waitForActualTasks(this.graceMs)
    const result: TaskScopeCloseResult = {
      settled,
      lingeringTaskIds: settled ? [] : this.getLingeringTaskIds()
    }
    this.lastCloseResult = result

    // 父 scope 必须能看到仍在运行的子任务；只有真实收敛后才能从父集合移除。
    void this.waitForAllActualTasks().then(() => {
      if (this.parent && this.onParentAbort) {
        this.parent.signal.removeEventListener('abort', this.onParentAbort)
        this.parent.childScopes.delete(this)
      }
    })
    return result
  }

  /** 有限宽限期内等待所有已启动任务和子 scope 的真实生命周期结束 */
  private async waitForActualTasks(graceMs: number): Promise<boolean> {
    const actual = this.waitForAllActualTasks()
    let settled = false
    void actual.then(() => {
      settled = true
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs)
    })
    try {
      await Promise.race([actual, timeout])
      return settled
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** close 后不再允许新增任务，因此快照即可代表该 scope 的完整真实生命周期。 */
  private async waitForAllActualTasks(): Promise<void> {
    const tasks = [...this.tasks.values()].map((task) => task.actualPromise)
    const scopes = [...this.childScopes].map((scope) => scope.waitForAllActualTasks())
    await Promise.allSettled([...tasks, ...scopes])
  }

  private getLingeringTaskIds(): string[] {
    return [
      ...this.tasks.keys(),
      ...[...this.childScopes].flatMap((scope) => scope.getLingeringTaskIds())
    ]
  }
}

/**
 * 在根 scope 内跑 guest 工作；无论成功失败都 close。
 * deadline 真正 abort scope，不会留下可写副作用的旧 continuation。
 */
export async function withTaskScope<T>(
  opts: TaskScopeOptions,
  fn: (scope: TaskScope) => Promise<T>
): Promise<T> {
  const scope = new TaskScope(opts)
  const gen = scope.captureGeneration()
  try {
    const result = await scope.spawn(() => fn(scope), { label: 'root-work' })
    if (!scope.isCurrent(gen) && scope.reason === 'deadline') {
      throw new Error('workflow script deadline exceeded')
    }
    await scope.close('completed')
    return result
  } catch (err) {
    const reason: TaskScopeReason =
      scope.reason === 'deadline'
        ? 'deadline'
        : scope.reason === 'cancelled' || scope.reason === 'parent_closed'
          ? 'cancelled'
          : 'failed'
    if (!scope.isClosed) {
      await scope.close(reason)
    }
    if (scope.reason === 'deadline') {
      throw new Error('workflow script deadline exceeded')
    }
    throw err
  }
}

/** 测试辅助：重置 scope id 计数 */
export function _resetTaskScopeIdForTests(): void {
  nextScopeId = 1
}
