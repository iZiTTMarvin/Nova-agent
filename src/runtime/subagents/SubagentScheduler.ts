export type SubagentScheduleRejectionCode =
  | 'global_limit'
  | 'root_limit'
  | 'queue_full'
  | 'run_active'
  | 'aborted'
  | 'wait_timeout'

export interface SubagentSchedulerLimits {
  readonly globalLimit: number
  readonly perRootLimit: number
  readonly maxQueued: number
  readonly waitTimeoutMs: number
}

export interface SubagentPermit {
  readonly runId: string
  readonly rootRunId: string
  readonly requestKey: string
  release(): void
}

export type SubagentPermitResult =
  | { readonly ok: true; readonly permit: SubagentPermit }
  | {
      readonly ok: false
      readonly code: SubagentScheduleRejectionCode
      readonly message: string
      readonly retryable: boolean
    }

export interface AcquireSubagentPermitInput {
  readonly runId: string
  readonly rootRunId: string
  readonly requestKey: string
  /** 默认立即返回结构化拒绝；批处理可显式进入有界 FIFO 队列。 */
  readonly wait?: boolean
  readonly abortSignal?: AbortSignal
}

interface Waiter {
  readonly input: AcquireSubagentPermitInput
  readonly resolve: (result: SubagentPermitResult) => void
  timer: ReturnType<typeof setTimeout> | null
  abortListener: (() => void) | null
}

const DEFAULT_LIMITS: SubagentSchedulerLimits = {
  globalLimit: 4,
  perRootLimit: 3,
  maxQueued: 16,
  waitTimeoutMs: 30_000
}

/**
 * 子代理并发的唯一 Owner。立即请求不会静默排队；显式等待使用有界 FIFO，
 * permit 的全部退出路径都通过幂等 release 回收。
 */
export class SubagentScheduler {
  private readonly limits: SubagentSchedulerLimits
  private activeGlobal = 0
  private readonly activeByRoot = new Map<string, number>()
  private readonly activeByRun = new Map<string, SubagentPermit>()
  private readonly queue: Waiter[] = []

  constructor(limits: Partial<SubagentSchedulerLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`SubagentScheduler ${name} 必须是非负整数`)
      }
    }
    if (this.limits.globalLimit < 1 || this.limits.perRootLimit < 1) {
      throw new Error('SubagentScheduler 并发上限必须至少为 1')
    }
    if (this.limits.waitTimeoutMs < 1) {
      throw new Error('SubagentScheduler 等待超时必须至少为 1ms，禁止无限排队')
    }
  }

  acquire(input: AcquireSubagentPermitInput): Promise<SubagentPermitResult> {
    if (input.abortSignal?.aborted) {
      return Promise.resolve(this.reject('aborted', '子代理请求已取消', false))
    }
    if (
      this.activeByRun.has(input.runId) ||
      this.queue.some((waiter) => waiter.input.runId === input.runId)
    ) {
      return Promise.resolve(
        this.reject('run_active', `child run ${input.runId} 已持有或正在等待执行名额`, false)
      )
    }
    const capacity = this.capacityRejection(input.rootRunId)
    if (!capacity) return Promise.resolve(this.grant(input))
    if (!input.wait) return Promise.resolve(capacity)
    if (this.queue.length >= this.limits.maxQueued) {
      return Promise.resolve(this.reject('queue_full', '子代理等待队列已满', true))
    }

    return new Promise<SubagentPermitResult>((resolve) => {
      const waiter: Waiter = {
        input,
        resolve,
        timer: null,
        abortListener: null
      }
      if (this.limits.waitTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          if (!this.removeWaiter(waiter)) return
          this.cleanupWaiter(waiter)
          resolve(this.reject('wait_timeout', '等待子代理执行名额超时', true))
        }, this.limits.waitTimeoutMs)
      }
      if (input.abortSignal) {
        waiter.abortListener = () => {
          if (!this.removeWaiter(waiter)) return
          this.cleanupWaiter(waiter)
          resolve(this.reject('aborted', '子代理请求已取消', false))
        }
        input.abortSignal.addEventListener('abort', waiter.abortListener, { once: true })
      }
      this.queue.push(waiter)
    })
  }

  snapshot(): { activeGlobal: number; activeByRoot: ReadonlyMap<string, number>; queued: number } {
    return {
      activeGlobal: this.activeGlobal,
      activeByRoot: new Map(this.activeByRoot),
      queued: this.queue.length
    }
  }

  /** 生命周期取消可同时回收活动 permit 或移除排队请求。 */
  releaseForRun(runId: string): boolean {
    const permit = this.activeByRun.get(runId)
    if (permit) {
      permit.release()
      return true
    }
    const waiter = this.queue.find((entry) => entry.input.runId === runId)
    if (!waiter || !this.removeWaiter(waiter)) return false
    this.cleanupWaiter(waiter)
    waiter.resolve(this.reject('aborted', '子代理请求已取消', false))
    return true
  }

  private capacityRejection(rootRunId: string): SubagentPermitResult | null {
    if (this.activeGlobal >= this.limits.globalLimit) {
      return this.reject('global_limit', '已达到全局子代理并发上限', true)
    }
    if ((this.activeByRoot.get(rootRunId) ?? 0) >= this.limits.perRootLimit) {
      return this.reject('root_limit', '已达到当前根任务的子代理并发上限', true)
    }
    return null
  }

  private grant(input: AcquireSubagentPermitInput): SubagentPermitResult {
    this.activeGlobal += 1
    this.activeByRoot.set(input.rootRunId, (this.activeByRoot.get(input.rootRunId) ?? 0) + 1)
    let released = false
    let permit!: SubagentPermit
    permit = {
      runId: input.runId,
      rootRunId: input.rootRunId,
      requestKey: input.requestKey,
      release: () => {
        if (released) return
        released = true
        if (this.activeByRun.get(input.runId) === permit) {
          this.activeByRun.delete(input.runId)
        }
        this.activeGlobal = Math.max(0, this.activeGlobal - 1)
        const next = Math.max(0, (this.activeByRoot.get(input.rootRunId) ?? 1) - 1)
        if (next === 0) this.activeByRoot.delete(input.rootRunId)
        else this.activeByRoot.set(input.rootRunId, next)
        this.drain()
      }
    }
    this.activeByRun.set(input.runId, permit)
    return {
      ok: true,
      permit
    }
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const waiter = this.queue[0]
      if (this.capacityRejection(waiter.input.rootRunId)) return
      this.queue.shift()
      this.cleanupWaiter(waiter)
      waiter.resolve(this.grant(waiter.input))
    }
  }

  private removeWaiter(waiter: Waiter): boolean {
    const index = this.queue.indexOf(waiter)
    if (index < 0) return false
    this.queue.splice(index, 1)
    if (index === 0) this.drain()
    return true
  }

  private cleanupWaiter(waiter: Waiter): void {
    if (waiter.timer !== null) clearTimeout(waiter.timer)
    if (waiter.abortListener && waiter.input.abortSignal) {
      waiter.input.abortSignal.removeEventListener('abort', waiter.abortListener)
    }
    waiter.timer = null
    waiter.abortListener = null
  }

  private reject(
    code: SubagentScheduleRejectionCode,
    message: string,
    retryable: boolean
  ): Extract<SubagentPermitResult, { ok: false }> {
    return { ok: false, code, message, retryable }
  }
}

export class SubagentScheduleRejectedError extends Error {
  readonly name = 'SubagentScheduleRejectedError'

  constructor(readonly rejection: Extract<SubagentPermitResult, { ok: false }>) {
    super(rejection.message)
  }
}
