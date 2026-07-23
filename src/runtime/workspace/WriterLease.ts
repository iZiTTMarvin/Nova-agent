/**
 * 工作区写者租约（writer lease）：单写者多读者模型。
 *
 * 并发模型下同一工作区允许多个 run 并发推理和只读操作，但同一时刻最多只允许一个
 * run 执行写入（edit / write / 有副作用的 bash），避免并发写入互相覆盖破坏文件。
 *
 * 设计要点：
 * - 惰性获取：不在 turn 开始抢租约，而在该 run 第一次写操作时获取，减少不必要的互斥。
 * - 幂等：同一 run 持有租约期间，后续写操作直接通过。
 * - 排队等待 + 超时：其他 run 的写操作 await 等租约释放；超时（默认 60s）返回冲突，
 *   让 agent 重新读取并重新规划，不永久阻塞。
 * - 不抢占：第一版不做 writer 抢占，租约持有到 turn 终态 / waiting_user 释放。
 *
 * 该模块是纯逻辑、不依赖 Electron，可独立单测。
 */

/** 一份租约：记录持租的工作区与 run。 */
export interface WriterLease {
  workspaceRoot: string
  runId: string
  acquiredAt: number
}

/** acquire 结果：成功拿到租约，或因超时 / 取消未能拿到。 */
export type AcquireResult =
  | { ok: true }
  | { ok: false; reason: 'timeout'; holderRunId: string }
  | { ok: false; reason: 'aborted' }

interface Waiter {
  runId: string
  resolve: (result: AcquireResult) => void
  timer: ReturnType<typeof setTimeout> | null
  /** abort 信号引用：任何退出路径都需 removeEventListener，避免监听器随 run 生命周期累积泄漏 */
  abortSignal: AbortSignal | null
  onAbort: (() => void) | null
}

/** 默认租约等待超时（毫秒）。 */
export const DEFAULT_LEASE_TIMEOUT_MS = 60_000

/**
 * 进程内单例登记表：工作区 → 当前持租 run。
 *
 * leaseByWorkspace：每个工作区同时最多一个持租者。
 * runIndex：每个 run 当前持有的工作区集合（一个 run 可能跨多个工作区，释放时按 run 一次清掉）。
 * waiters：每个工作区的等待队列（FIFO），租约释放时按顺序唤醒队首。
 */
class WorkspaceWriterLeaseRegistry {
  private readonly leaseByWorkspace = new Map<string, WriterLease>()
  private readonly runIndex = new Map<string, Set<string>>()
  private readonly waitersByWorkspace = new Map<string, Waiter[]>()

  /**
   * 为指定 run 在指定工作区获取写者租约。
   *
   * - 工作区无人持租或持租者就是本 run：立即成功（幂等）。
   * - 已被其他 run 持有：进入等待队列，持租者释放时按 FIFO 唤醒；超时返回冲突。
   * - 调用方可传 abortSignal：run 被取消时立即从队列移除并返回 aborted，避免持租者
   *   释放后把租约授予已死掉的 run 造成永久死锁。
   */
  acquire(
    workspaceRoot: string,
    runId: string,
    timeoutMs: number = DEFAULT_LEASE_TIMEOUT_MS,
    abortSignal?: AbortSignal
  ): Promise<AcquireResult> {
    // 已取消的 run 不排队
    if (abortSignal?.aborted) {
      return Promise.resolve({ ok: false, reason: 'aborted' })
    }
    const existing = this.leaseByWorkspace.get(workspaceRoot)
    // 幂等：本 run 已持租
    if (existing && existing.runId === runId) {
      return Promise.resolve({ ok: true })
    }
    // 无持租者：直接获取
    if (!existing) {
      this.grant(workspaceRoot, runId)
      return Promise.resolve({ ok: true })
    }
    // 已被他人持租：排队等待
    return new Promise<AcquireResult>((resolve) => {
      const waiter: Waiter = { runId, resolve, timer: null, abortSignal: null, onAbort: null }

      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.removeWaiter(workspaceRoot, waiter)
          this.cleanupWaiter(waiter)
          // 超时时若仍未持租，返回冲突；若刚好被唤醒则忽略（resolve 已被调用）
          const cur = this.leaseByWorkspace.get(workspaceRoot)
          if (!cur || cur.runId !== runId) {
            resolve({ ok: false, reason: 'timeout', holderRunId: cur?.runId ?? '' })
          }
        }, timeoutMs)
      }

      // 取消信号：立即出队并返回 aborted，防止租约授予已死掉的 run
      if (abortSignal) {
        const onAbort = (): void => {
          this.removeWaiter(workspaceRoot, waiter)
          this.cleanupWaiter(waiter)
          resolve({ ok: false, reason: 'aborted' })
        }
        waiter.onAbort = onAbort
        waiter.abortSignal = abortSignal
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }

      this.pushWaiter(workspaceRoot, waiter)
    })
  }

  /** 查询某工作区当前持租 run（无持租者为 null）。 */
  holder(workspaceRoot: string): string | null {
    return this.leaseByWorkspace.get(workspaceRoot)?.runId ?? null
  }

  /**
   * 释放指定 run 持有的全部租约与等待位（turn 终态 / waiting_user / 取消时调用）。
   *
   * 两件事都必须做：
   * 1. 若该 run 是某工作区的持租者，删除租约并唤醒下一个等待者。
   * 2. 若该 run 还排在某些工作区的等待队列里（未拿到租约就被取消），从队列移除它，
   *    否则持租者释放后会按 FIFO 把租约授予这个已死掉的 run，而它再也不会 release，
   *    导致该工作区永久写锁死。
   */
  release(runId: string): void {
    // 1. 释放该 run 已持有的租约
    const workspaces = this.runIndex.get(runId)
    if (workspaces && workspaces.size > 0) {
      for (const workspaceRoot of workspaces) {
        const lease = this.leaseByWorkspace.get(workspaceRoot)
        if (lease && lease.runId === runId) {
          this.leaseByWorkspace.delete(workspaceRoot)
          this.grantToNextWaiter(workspaceRoot)
        }
      }
      this.runIndex.delete(runId)
    }

    // 2. 清理该 run 在所有工作区等待队列里的残留 waiter
    for (const [workspaceRoot, queue] of this.waitersByWorkspace) {
      const remaining = queue.filter((w) => {
        if (w.runId !== runId) return true
        // 还原该 waiter：清定时器、移除 abort 监听、用 aborted 结算
        this.cleanupWaiter(w)
        w.resolve({ ok: false, reason: 'aborted' })
        return false
      })
      if (remaining.length === 0) {
        this.waitersByWorkspace.delete(workspaceRoot)
      } else {
        this.waitersByWorkspace.set(workspaceRoot, remaining)
      }
    }
  }

  /** 测试用：重置全部租约与等待队列。 */
  resetForTests(): void {
    for (const waiters of this.waitersByWorkspace.values()) {
      for (const w of waiters) {
        this.cleanupWaiter(w)
      }
    }
    this.leaseByWorkspace.clear()
    this.runIndex.clear()
    this.waitersByWorkspace.clear()
  }

  /**
   * 统一清理 waiter 持有的定时器与 abort 监听器。
   *
   * waiter 退出队列有三条路径（超时 / 被授予 / release 清理 / reset），
   * 每条都必须移除 abort 监听器，否则监听器会随 abortSignal 生命周期累积泄漏。
   */
  private cleanupWaiter(w: Waiter): void {
    if (w.timer) {
      clearTimeout(w.timer)
      w.timer = null
    }
    if (w.onAbort && w.abortSignal) {
      w.abortSignal.removeEventListener('abort', w.onAbort)
      w.onAbort = null
      w.abortSignal = null
    }
  }

  private grant(workspaceRoot: string, runId: string): void {
    this.leaseByWorkspace.set(workspaceRoot, {
      workspaceRoot,
      runId,
      acquiredAt: Date.now()
    })
    let set = this.runIndex.get(runId)
    if (!set) {
      set = new Set()
      this.runIndex.set(runId, set)
    }
    set.add(workspaceRoot)
  }

  private pushWaiter(workspaceRoot: string, waiter: Waiter): void {
    let q = this.waitersByWorkspace.get(workspaceRoot)
    if (!q) {
      q = []
      this.waitersByWorkspace.set(workspaceRoot, q)
    }
    q.push(waiter)
  }

  private removeWaiter(workspaceRoot: string, waiter: Waiter): void {
    const q = this.waitersByWorkspace.get(workspaceRoot)
    if (!q) return
    const idx = q.indexOf(waiter)
    if (idx >= 0) q.splice(idx, 1)
    if (q.length === 0) this.waitersByWorkspace.delete(workspaceRoot)
  }

  /**
   * 把某工作区的租约交给等待队列的队首。
   *
   * 队首的 waiter 可能已因超时或 abort 被 removeWaiter 移除（此时队列已不含它），
   * 因此这里直接授予当前队首即可；若队列为空则删除整个队列条目。
   */
  private grantToNextWaiter(workspaceRoot: string): void {
    const q = this.waitersByWorkspace.get(workspaceRoot)
    if (!q || q.length === 0) {
      this.waitersByWorkspace.delete(workspaceRoot)
      return
    }
    const next = q.shift()!
    // 被授予的 waiter 不再需要定时器 / abort 监听（已拿到租约）
    this.cleanupWaiter(next)
    if (q.length === 0) this.waitersByWorkspace.delete(workspaceRoot)
    this.grant(workspaceRoot, next.runId)
    next.resolve({ ok: true })
  }
}

/** 进程内单例。挂在主进程，写工具经 ToolContext 访问。 */
export const writerLeaseRegistry = new WorkspaceWriterLeaseRegistry()
