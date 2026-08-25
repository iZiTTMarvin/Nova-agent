/**
 * 持久进程会话登记表：长跑子进程生命周期的唯一 Owner。
 *
 * bash 工具负责 spawn 并以闭包注入终止/写入能力；本模块只做登记、输出游标读取、
 * 容量上限与四条清理路径（会话删除 / run 终态 / 应用退出 / headless 退出）的终止编排。
 * 不 import child_process 与 bash 工具实现，依赖方向为零。
 */
import { randomBytes } from 'node:crypto'
import type { WorkspaceSnapshot } from '../checkpoints/snapshot'
import { SessionOutputJournal } from './journal'
import {
  ProcessSessionError,
  type ProcessOwner,
  type ProcessSessionSource,
  type ProcessSessionState,
  type ReadPage,
  type RegisterProcessInput
} from './types'

export const MAX_ACTIVE_PROCESSES_PER_SESSION = 8
export const TERMINATE_TIMEOUT_MS = 10_000
export const RETAINED_UNREAD_CAP_BYTES = 1_000_000

const REF_PREFIX = 'psn_'
const REF_BODY_PATTERN = /^[A-Za-z0-9_-]{12}$/

export interface SessionHandle {
  ref: string
  append(text: string): void
  settle(exitCode: number | null): void
}

export interface SessionDescribe {
  state: ProcessSessionState
  exitCode: number | null
  command: string
  source: ProcessSessionSource
  destructive: boolean
  owner: ProcessOwner
}

interface ProcessRecord {
  ref: string
  owner: ProcessOwner
  source: ProcessSessionSource
  command: string
  destructive: boolean
  state: ProcessSessionState
  exitCode: number | null
  journal: SessionOutputJournal
  child: RegisterProcessInput['child']
  killTree: () => Promise<void>
  writeStdin: (data: string) => Promise<void>
  interrupt: (() => boolean) | undefined
  flushPendingOutput: (() => string) | undefined
  checkpointBaseline: WorkspaceSnapshot | null
  /** 同记录写操作（write / stop）串行链 */
  chain: Promise<unknown>
}

export class ProcessRegistry {
  private readonly records = new Map<string, ProcessRecord>()
  private readonly terminateTimeoutMs: number

  /** 测试可注入 terminateTimeoutMs 避免真等 */
  constructor(opts: { terminateTimeoutMs?: number } = {}) {
    this.terminateTimeoutMs = opts.terminateTimeoutMs ?? TERMINATE_TIMEOUT_MS
  }

  /**
   * 登记一个已 spawn 的进程。容量超限直接拒绝，绝不淘汰已存在记录；
   * child 在注册瞬间已退出时以 exited 状态登记，走同一条终态交付路径。
   */
  register(input: RegisterProcessInput): SessionHandle {
    const activeCount = this.countRunning(input.owner.sessionId)
    if (activeCount >= MAX_ACTIVE_PROCESSES_PER_SESSION) {
      throw new ProcessSessionError(
        'active-limit',
        `会话 ${input.owner.sessionId} 的活跃进程已达上限 ${MAX_ACTIVE_PROCESSES_PER_SESSION}，请先停止不再使用的会话`
      )
    }
    const retained = this.retainedUnreadBytes()
    if (retained > RETAINED_UNREAD_CAP_BYTES) {
      throw new ProcessSessionError(
        'retained-bytes-limit',
        `已退出会话的未读输出共约 ${Math.round(retained / 1024)}KB，超过 ${RETAINED_UNREAD_CAP_BYTES / 1024}KB 上限，请先读取或清理`
      )
    }
    const ref = this.allocateRef()
    const journal = new SessionOutputJournal({ seed: input.seedOutput })
    const record: ProcessRecord = {
      ref,
      owner: input.owner,
      source: input.source,
      command: input.command,
      destructive: input.destructive,
      state: 'running',
      exitCode: null,
      journal,
      child: input.child,
      killTree: input.killTree,
      writeStdin: input.writeStdin,
      interrupt: input.interrupt,
      flushPendingOutput: input.flushPendingOutput,
      checkpointBaseline: input.checkpointBaseline,
      chain: Promise.resolve()
    }
    this.records.set(ref, record)
    // child 事件是退出的自主感知通道，与调用方 handle.settle 互为双保险（settleRecord 幂等）
    input.child.once('close', () => this.settleRecord(record, input.child.exitCode))
    input.child.once('error', () => this.settleRecord(record, input.child.exitCode))
    if (input.child.exitCode !== null || input.child.signalCode !== null) {
      this.settleRecord(record, input.child.exitCode)
    }
    return {
      ref,
      append: (text) => {
        journal.append(text)
      },
      settle: (exitCode) => {
        this.settleRecord(record, exitCode)
      }
    }
  }

  readPage(
    ref: string,
    sessionId: string
  ): { page: ReadPage; state: ProcessSessionState; exitCode: number | null } {
    const record = this.resolve(ref, sessionId)
    return { page: record.journal.readUnread(), state: record.state, exitCode: record.exitCode }
  }

  writeInput(ref: string, sessionId: string, input: string): Promise<{ state: ProcessSessionState }> {
    const record = this.resolve(ref, sessionId)
    if (record.state === 'exited') {
      throw new ProcessSessionError(
        'process-exited',
        '进程已退出，无法再写入 stdin；未读输出仍可通过 read 获取'
      )
    }
    return this.enqueue(record, async () => {
      await record.writeStdin(input)
      return { state: record.state }
    })
  }

  interrupt(ref: string, sessionId: string): { state: ProcessSessionState } {
    const record = this.resolve(ref, sessionId)
    if (!record.interrupt) {
      throw new ProcessSessionError(
        'unsupported-on-windows',
        '当前平台不支持中断运行中的进程，请改用 stop 终止会话'
      )
    }
    record.interrupt()
    return { state: record.state }
  }

  async stopSession(ref: string, sessionId: string): Promise<{ page: ReadPage; exitCode: number | null }> {
    const record = this.resolve(ref, sessionId)
    if (record.state === 'exited') {
      return { page: record.journal.readUnread(), exitCode: record.exitCode }
    }
    await this.enqueue(record, () => this.awaitTermination(record))
    return { page: record.journal.readUnread(), exitCode: record.exitCode }
  }

  describe(ref: string, sessionId: string): SessionDescribe {
    const record = this.resolve(ref, sessionId)
    return {
      state: record.state,
      exitCode: record.exitCode,
      command: record.command,
      source: record.source,
      destructive: record.destructive,
      owner: record.owner
    }
  }

  /**
   * 有界等待新输出：已有未读立即 'data'；静默 silenceMs 内无任何新数据 'quiet'；
   * 有数据后每 silenceMs 静默即返回 'data'；总 maxMs 到限 'cap'；进程终态 'settled'；
   * abortSignal 触发按当前状况返回 'quiet'。监听器全部清理，不读取内容（由 readPage 取增量）。
   */
  waitForOutput(
    ref: string,
    sessionId: string,
    opts: { silenceMs: number; maxMs: number; abortSignal?: AbortSignal }
  ): Promise<'data' | 'quiet' | 'settled' | 'cap'> {
    const record = this.resolve(ref, sessionId)
    if (record.state === 'exited') return Promise.resolve('settled')
    if (record.journal.hasUnread()) return Promise.resolve('data')
    return new Promise((resolve) => {
      let finished = false
      let sawData = false
      let silenceTimer: ReturnType<typeof setTimeout> | null = null
      let maxTimer: ReturnType<typeof setTimeout> | null = null
      let offOutput: (() => void) | null = null
      let offSettled: (() => void) | null = null
      const onAbort = () => finish('quiet')
      const finish = (outcome: 'data' | 'quiet' | 'settled' | 'cap') => {
        if (finished) return
        finished = true
        if (silenceTimer !== null) clearTimeout(silenceTimer)
        if (maxTimer !== null) clearTimeout(maxTimer)
        offOutput?.()
        offSettled?.()
        if (opts.abortSignal) {
          opts.abortSignal.removeEventListener('abort', onAbort)
        }
        resolve(outcome)
      }
      // 任何一个数据到达都重置静默计时；计时走完时按「期间是否见过数据」区分 data / quiet
      const armSilence = () => {
        if (silenceTimer !== null) clearTimeout(silenceTimer)
        silenceTimer = setTimeout(() => finish(sawData ? 'data' : 'quiet'), opts.silenceMs)
      }
      maxTimer = setTimeout(() => finish('cap'), opts.maxMs)
      armSilence()
      offOutput = record.journal.onOutput(() => {
        sawData = true
        armSilence()
      })
      // journal.onSettled 对已终态订阅会立即唤醒，覆盖订阅前一瞬 settle 的竞态
      offSettled = record.journal.onSettled(() => finish('settled'))
      if (opts.abortSignal) {
        if (opts.abortSignal.aborted) {
          finish('quiet')
          return
        }
        opts.abortSignal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  getCheckpointBaseline(ref: string, sessionId: string): WorkspaceSnapshot | null {
    return this.resolve(ref, sessionId).checkpointBaseline
  }

  updateCheckpointBaseline(ref: string, sessionId: string, next: WorkspaceSnapshot | null): void {
    this.resolve(ref, sessionId).checkpointBaseline = next
  }

  /** 会话范围终止：杀掉并移除该 sessionId 全部记录 */
  async terminateForSession(sessionId: string): Promise<void> {
    await Promise.all(
      [...this.records.values()]
        .filter((r) => r.owner.sessionId === sessionId)
        .map((r) => this.terminateRecord(r))
    )
  }

  /**
   * run 范围终止：includeMainRun=true 杀该 runId 全部记录（用户中止）；
   * false 只杀 source==='subagent-run' 的记录，主 run 正常完成的进程跨 turn 存活。
   */
  async terminateForRun(runId: string, opts: { includeMainRun: boolean }): Promise<void> {
    await Promise.all(
      [...this.records.values()]
        .filter(
          (r) => r.owner.runId === runId && (opts.includeMainRun || r.source === 'subagent-run')
        )
        .map((r) => this.terminateRecord(r))
    )
  }

  async terminateAll(): Promise<void> {
    await Promise.all([...this.records.values()].map((r) => this.terminateRecord(r)))
  }

  resetForTests(): void {
    this.records.clear()
  }

  /**
   * 终止一个 running 记录：killTree 与超时竞速。
   * 核心安全属性：超时未确认（含 killTree 抛异常）时释放全部 registry 侧引用，
   * 绝不留永久等待的记录。
   */
  private awaitTermination(record: ProcessRecord): Promise<void> {
    if (record.state === 'exited') return Promise.resolve()
    return new Promise<void>((resolve) => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.dropUnresponsive(record, `killTree ${this.terminateTimeoutMs}ms 内未确认退出`)
        finish()
      }, this.terminateTimeoutMs)
      Promise.resolve()
        .then(() => record.killTree())
        .then(
          () => {
            this.settleRecord(record, record.child.exitCode)
            finish()
          },
          () => {
            this.dropUnresponsive(record, 'killTree 抛出异常')
            finish()
          }
        )
    })
  }

  /**
   * 范围终态清理：先等终止完成，再移除记录并释放输出内存。
   * 刻意不走写串行链——退出清理不能排在可能悬挂的用户写后面。
   */
  private async terminateRecord(record: ProcessRecord): Promise<void> {
    await this.awaitTermination(record)
    this.records.delete(record.ref)
    record.journal.dispose()
  }

  private dropUnresponsive(record: ProcessRecord, reason: string): void {
    this.records.delete(record.ref)
    record.journal.dispose()
    console.error(
      `[process-registry] 进程终止未确认，已放弃跟踪 ref=${record.ref} ` +
        `command=${JSON.stringify(record.command)} reason=${reason}`
    )
  }

  /** 幂等终态：首个到达的退出通知胜出，后到的不覆盖；终结前先排空缓冲输出 */
  private settleRecord(record: ProcessRecord, exitCode: number | null): void {
    if (record.state === 'exited') return
    // 净化器等调用方缓冲可能滞留无尾换行的最后一行（REPL 提示符正是这种形态），
    // 必须在关闭 journal 前入账，否则静默丢失
    const pending = record.flushPendingOutput?.() ?? ''
    if (pending.length > 0) record.journal.append(pending)
    record.state = 'exited'
    record.exitCode = exitCode
    record.journal.settle()
  }

  private enqueue<T>(record: ProcessRecord, op: () => Promise<T>): Promise<T> {
    const run = record.chain.then(op, op)
    // 链上失败不阻塞后续操作
    record.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** 先按格式快筛再查表，任意字符串不进入表查询；越权与未知必须可区分 */
  private resolve(ref: string, sessionId: string): ProcessRecord {
    const wellFormed =
      ref.startsWith(REF_PREFIX) && REF_BODY_PATTERN.test(ref.slice(REF_PREFIX.length))
    const record = wellFormed ? this.records.get(ref) : undefined
    if (!record) {
      throw new ProcessSessionError('unknown-ref', `未知的进程会话引用: ${ref}`)
    }
    if (record.owner.sessionId !== sessionId) {
      throw new ProcessSessionError(
        'not-authorized',
        `进程会话 ${ref} 不属于会话 ${sessionId}，拒绝访问`
      )
    }
    return record
  }

  private allocateRef(): string {
    for (;;) {
      // 随机 ref 不暴露 PID，避免成为跨进程操作句柄
      const ref = `${REF_PREFIX}${randomBytes(9).toString('base64url')}`
      if (!this.records.has(ref)) return ref
    }
  }

  private countRunning(sessionId: string): number {
    let n = 0
    for (const r of this.records.values()) {
      if (r.state === 'running' && r.owner.sessionId === sessionId) n += 1
    }
    return n
  }

  private retainedUnreadBytes(): number {
    let sum = 0
    for (const r of this.records.values()) {
      if (r.state === 'exited') sum += r.journal.unreadBytes()
    }
    return sum
  }
}

/** 进程内单例，供 bash 工具与各清理路径共用（形态同 workspace/writerLeaseRegistry）。 */
export const processRegistry = new ProcessRegistry()
