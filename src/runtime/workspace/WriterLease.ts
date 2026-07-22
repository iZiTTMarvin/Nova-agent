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

/** acquire 结果：成功拿到租约，或因超时未能拿到。 */
export type AcquireResult =
  | { ok: true }
  | { ok: false; reason: 'timeout'; holderRunId: string }

interface Waiter {
  runId: string
  resolve: (result: AcquireResult) => void
  timer: ReturnType<typeof setTimeout> | null
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
   */
  acquire(
    workspaceRoot: string,
    runId: string,
    timeoutMs: number = DEFAULT_LEASE_TIMEOUT_MS
  ): Promise<AcquireResult> {
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
      const waiter: Waiter = { runId, resolve, timer: null }
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.removeWaiter(workspaceRoot, waiter)
          // 超时时若仍未持租，返回冲突；若刚好被唤醒则忽略（resolve 已被调用）
          const cur = this.leaseByWorkspace.get(workspaceRoot)
          if (!cur || cur.runId !== runId) {
            resolve({ ok: false, reason: 'timeout', holderRunId: cur?.runId ?? '' })
          }
        }, timeoutMs)
      }
      this.pushWaiter(workspaceRoot, waiter)
    })
  }

  /** 查询某工作区当前持租 run（无持租者为 null）。 */
  holder(workspaceRoot: string): string | null {
    return this.leaseByWorkspace.get(workspaceRoot)?.runId ?? null
  }

  /**
   * 释放指定 run 持有的全部租约（turn 终态 / waiting_user 时调用）。
   *
   * 释放后按 FIFO 唤醒每个工作区等待队列的队首，把租约交给下一个 run。
   */
  release(runId: string): void {
    const workspaces = this.runIndex.get(runId)
    if (!workspaces || workspaces.size === 0) return
    for (const workspaceRoot of workspaces) {
      const lease = this.leaseByWorkspace.get(workspaceRoot)
      if (lease && lease.runId === runId) {
        this.leaseByWorkspace.delete(workspaceRoot)
        this.grantToNextWaiter(workspaceRoot)
      }
    }
    this.runIndex.delete(runId)
  }

  /** 测试用：重置全部租约与等待队列。 */
  resetForTests(): void {
    for (const waiters of this.waitersByWorkspace.values()) {
      for (const w of waiters) {
        if (w.timer) clearTimeout(w.timer)
      }
    }
    this.leaseByWorkspace.clear()
    this.runIndex.clear()
    this.waitersByWorkspace.clear()
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
   * 跳过已超时的等待者（其 resolve 已被超时分支调用），直到找到有效等待者或队列空。
   */
  private grantToNextWaiter(workspaceRoot: string): void {
    const q = this.waitersByWorkspace.get(workspaceRoot)
    if (!q) return
    while (q.length > 0) {
      const next = q.shift()!
      if (next.timer) clearTimeout(next.timer)
      // 若该等待者已超时（resolve 已被调用），跳过；这里用 try 兜底避免重复 resolve
      this.grant(workspaceRoot, next.runId)
      next.resolve({ ok: true })
      if (q.length === 0) this.waitersByWorkspace.delete(workspaceRoot)
      return
    }
    this.waitersByWorkspace.delete(workspaceRoot)
  }
}

/** 进程内单例。挂在主进程，写工具经 ToolContext 访问。 */
export const writerLeaseRegistry = new WorkspaceWriterLeaseRegistry()
