/**
 * RunCoordinator — 权威运行状态机
 *
 * 核心规则：
 * 1. Renderer 永远不是运行状态事实源
 * 2. terminal 状态只能由本类提交一次
 * 3. 事件带递增 sequence，丢事件后用 snapshot 自愈
 * 4. terminal hook 用 runId + terminalTransitionId + hookName 去重（exactly-once）
 */
import { randomUUID } from 'crypto'
import { InteractionInbox } from './InteractionInbox'
import { RunStore } from './RunStore'
import {
  isHardTerminalRunStatus,
  isTerminalRunStatus,
  RUN_STATUS_TRANSITIONS,
  type CommitTerminalParams,
  type InteractionCommandAck,
  type PendingInteraction,
  type RunAttemptInfo,
  type RunEventRecord,
  type RunKind,
  type RunProgress,
  type RunSnapshot,
  type RunStatus,
  type StartRunParams,
  type TerminalOutboxEntry,
  type ToolCommitPhase,
  type ToolCommitRecord
} from './types'

export type RunSnapshotListener = (snapshot: RunSnapshot, event: RunEventRecord) => void

export type TerminalHookName = 'onCancel' | 'onComplete' | 'onFail' | 'onInterrupt'

export interface TerminalHookContext {
  runId: string
  terminalTransitionId: string
  hookName: TerminalHookName
  snapshot: RunSnapshot
}

export type TerminalHookHandler = (ctx: TerminalHookContext) => void | Promise<void>

export interface RunCoordinatorOptions {
  store: RunStore
  /** 可选：状态变更时回调（主进程据此推 IPC） */
  onSnapshot?: RunSnapshotListener
}

export class RunCoordinator {
  private readonly store: RunStore
  private readonly onSnapshot?: RunSnapshotListener
  /** 内存热索引：runId → snapshot */
  private readonly runs = new Map<string, RunSnapshot>()
  /** sessionId → 活跃 runId 集合 */
  private readonly sessionIndex = new Map<string, Set<string>>()
  /** terminal hook 去重：`${runId}|${transitionId}|${hookName}` */
  private readonly firedTerminalHooks = new Set<string>()
  private readonly terminalHookHandlers = new Map<TerminalHookName, Set<TerminalHookHandler>>()
  readonly inbox: InteractionInbox

  constructor(opts: RunCoordinatorOptions) {
    this.store = opts.store
    this.onSnapshot = opts.onSnapshot
    this.inbox = new InteractionInbox(this)
  }

  // ── 启动 / 查询 ──────────────────────────────────────────

  /** 注册新 run（queued → 立刻可切 running） */
  startRun(params: StartRunParams): RunSnapshot {
    const now = Date.now()
    const runId = params.runId ?? randomUUID()
    const existing = this.runs.get(runId) ?? this.store.loadSnapshot(runId)
    if (existing && !isTerminalRunStatus(existing.status)) {
      // 幂等：同一 runId 未终态则返回现有
      this.runs.set(runId, existing)
      this.indexSession(existing.sessionId, runId)
      return existing
    }

    const snapshot: RunSnapshot = {
      runId,
      kind: params.kind,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      messageId: params.messageId ?? '',
      status: 'queued',
      sequence: 0,
      pendingInteractions: [],
      currentAttempt: null,
      progress: null,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
      toolCommits: [],
      turnDraft: null,
      commandAcks: [],
      terminalOutbox: []
    }
    this.commit(snapshot, 'run_started', { kind: params.kind })
    return cloneSnapshot(snapshot)
  }

  /** queued → running，并原子记录 turn_started */
  markRunning(runId: string, messageId?: string): RunSnapshot | null {
    const snap = this.requireMutable(runId)
    if (!snap) return null
    if (messageId) snap.messageId = messageId
    if (!snap.turnStartedAt) {
      snap.turnStartedAt = Date.now()
    }
    return this.transition(runId, 'running', 'turn_started', {
      messageId: snap.messageId,
      turnStartedAt: snap.turnStartedAt
    })
  }

  getSnapshot(runId: string): RunSnapshot | null {
    return this.runs.get(runId) ?? this.store.loadSnapshot(runId)
  }

  /** 按会话取最新 snapshot（含终态）；优先非终态 */
  getSnapshotForSession(sessionId: string): RunSnapshot | null {
    const activeIds = this.sessionIndex.get(sessionId)
    if (activeIds) {
      for (const runId of activeIds) {
        const snap = this.runs.get(runId)
        if (snap && !isTerminalRunStatus(snap.status)) return cloneSnapshot(snap)
      }
    }
    const fromDisk = this.store.findSnapshotsBySession(sessionId)
    if (fromDisk.length === 0) return null
    const nonTerminal = fromDisk.find(s => !isTerminalRunStatus(s.status))
    return cloneSnapshot(nonTerminal ?? fromDisk[0])
  }

  /** 会话下所有仍有 pending 交互的 snapshot（侧边栏徽标） */
  listWaitingSessions(): Array<{ sessionId: string; runId: string; pendingCount: number }> {
    const result: Array<{ sessionId: string; runId: string; pendingCount: number }> = []
    for (const snap of this.runs.values()) {
      const pending = snap.pendingInteractions.filter(
        i => i.status === 'pending' || i.status === 'submitting'
      )
      if (pending.length > 0 || snap.status === 'waiting_user') {
        result.push({
          sessionId: snap.sessionId,
          runId: snap.runId,
          pendingCount: Math.max(pending.length, snap.status === 'waiting_user' ? 1 : 0)
        })
      }
    }
    return result
  }

  /** 列出内存中所有非终态 run */
  listActiveRuns(): RunSnapshot[] {
    return [...this.runs.values()]
      .filter(s => !isTerminalRunStatus(s.status))
      .map(cloneSnapshot)
  }

  // ── 状态转换 ─────────────────────────────────────────────

  transition(
    runId: string,
    to: RunStatus,
    eventType: string,
    payload?: Record<string, unknown>
  ): RunSnapshot | null {
    const snap = this.requireMutable(runId)
    if (!snap) return null

    if (isHardTerminalRunStatus(snap.status)) {
      // 硬终态：禁止再转
      return cloneSnapshot(snap)
    }

    if (isHardTerminalRunStatus(to) || to === 'interrupted') {
      // 终态必须走 commitTerminal
      return this.commitTerminal({
        runId,
        status: to as CommitTerminalParams['status'],
        reason: typeof payload?.reason === 'string' ? payload.reason : undefined,
        terminalTransitionId:
          typeof payload?.terminalTransitionId === 'string'
            ? payload.terminalTransitionId
            : undefined
      })
    }

    // interrupted → resuming 等非硬终态转换
    if (isTerminalRunStatus(snap.status) && snap.status !== 'interrupted') {
      return cloneSnapshot(snap)
    }

    const allowed = RUN_STATUS_TRANSITIONS[snap.status]
    if (!allowed.includes(to)) {
      console.warn(
        `[RunCoordinator] 非法转换 ${snap.status} → ${to} (runId=${runId})，忽略`
      )
      return cloneSnapshot(snap)
    }

    snap.status = to
    snap.updatedAt = Date.now()
    snap.lastHeartbeatAt = snap.updatedAt
    this.commit(snap, eventType, payload)
    return cloneSnapshot(snap)
  }

  /** 进入 waiting_user */
  markWaitingUser(runId: string, progressLabel?: string): RunSnapshot | null {
    const snap = this.requireMutable(runId)
    if (!snap) return null
    if (snap.status === 'waiting_user') {
      if (progressLabel) {
        snap.progress = { ...(snap.progress ?? {}), label: progressLabel }
        snap.updatedAt = Date.now()
        this.commit(snap, 'waiting_user_progress', { label: progressLabel })
      }
      return cloneSnapshot(snap)
    }
    if (progressLabel) {
      snap.progress = { ...(snap.progress ?? {}), label: progressLabel }
    }
    return this.transition(runId, 'waiting_user', 'waiting_user', {
      label: progressLabel
    })
  }

  markRetrying(runId: string, attempt?: RunAttemptInfo): RunSnapshot | null {
    if (attempt) this.setCurrentAttempt(runId, attempt)
    return this.transition(runId, 'retrying', 'retrying', attempt as unknown as Record<string, unknown>)
  }

  /** 取消：立即 cancelling；真正终态由 commitTerminal('cancelled') 确认 */
  beginCancel(runId: string): RunSnapshot | null {
    const snap = this.requireMutable(runId)
    if (!snap) return null
    if (snap.status === 'cancelling') return cloneSnapshot(snap)
    return this.transition(runId, 'cancelling', 'cancelling')
  }

  /**
   * 提交终态（只能成功一次）。
   * 触发 terminal hook 时用 runId+terminalTransitionId+hookName 去重。
   */
  commitTerminal(params: CommitTerminalParams): RunSnapshot | null {
    const snap = this.requireMutable(params.runId)
    if (!snap) {
      // 可能已从磁盘加载为终态
      const existing = this.getSnapshot(params.runId)
      return existing ? cloneSnapshot(existing) : null
    }

    if (isHardTerminalRunStatus(snap.status) || snap.status === 'interrupted') {
      return cloneSnapshot(snap)
    }

    // cancelling → cancelled；其它路径允许直接 completed/failed/interrupted
    if (params.status === 'cancelled' && snap.status !== 'cancelling') {
      const allowed = RUN_STATUS_TRANSITIONS[snap.status]
      if (allowed.includes('cancelling')) {
        snap.status = 'cancelling'
        snap.updatedAt = Date.now()
      }
    } else if (params.status !== 'cancelled') {
      const viaCancelling = snap.status === 'cancelling'
      if (!viaCancelling) {
        const allowed = RUN_STATUS_TRANSITIONS[snap.status]
        // interrupted 可从多数非终态进入
        if (params.status === 'interrupted') {
          // 放行
        } else if (!allowed.includes(params.status) && !allowed.includes('cancelling')) {
          console.warn(
            `[RunCoordinator] 无法提交终态 ${params.status} from ${snap.status}`
          )
          return cloneSnapshot(snap)
        }
      }
    }

    const transitionId = params.terminalTransitionId ?? randomUUID()
    snap.status = params.status
    snap.terminalReason = params.reason
    snap.terminalTransitionId = transitionId
    snap.updatedAt = Date.now()
    snap.lastHeartbeatAt = snap.updatedAt

    // 取消挂起交互
    for (const inter of snap.pendingInteractions) {
      if (inter.status === 'pending' || inter.status === 'submitting') {
        inter.status = 'cancelled'
        inter.version += 1
      }
    }

    this.commit(snap, 'terminal', {
      status: params.status,
      reason: params.reason,
      terminalTransitionId: transitionId
    })

    // exactly-once terminal hooks
    const hookName = mapTerminalToHook(params.status)
    if (hookName) {
      void this.fireTerminalHook(params.runId, transitionId, hookName, snap)
    }

    return cloneSnapshot(snap)
  }

  heartbeat(runId: string, progress?: RunProgress): void {
    const snap = this.requireMutable(runId)
    if (!snap) return
    snap.lastHeartbeatAt = Date.now()
    snap.updatedAt = snap.lastHeartbeatAt
    if (progress) snap.progress = progress
    this.commit(snap, 'heartbeat', progress as unknown as Record<string, unknown>)
  }

  /**
   * 轻量刷新 lastHeartbeatAt（不落盘、不广播）。
   * 供事件流 / stall detector 使用，避免每个 text_delta 触发完整 commit。
   */
  touchHeartbeat(runId: string): void {
    const snap = this.runs.get(runId)
    if (!snap || isHardTerminalRunStatus(snap.status)) return
    const now = Date.now()
    snap.lastHeartbeatAt = now
    snap.updatedAt = now
  }

  /**
   * stall detector 用：返回 run 是否处于「应有心跳的活跃执行」及最近心跳时间。
   * waiting_user / retrying / cancelling / 终态 不算 stall 候选。
   */
  getStallLiveness(runId: string): {
    status: RunStatus
    lastHeartbeatAt: number
    /** true = 处于 running，超时未心跳才应告警 */
    expectHeartbeat: boolean
  } | null {
    const snap = this.runs.get(runId) ?? this.store.loadSnapshot(runId)
    if (!snap) return null
    return {
      status: snap.status,
      lastHeartbeatAt: snap.lastHeartbeatAt,
      expectHeartbeat: snap.status === 'running'
    }
  }

  setCurrentAttempt(runId: string, attempt: RunAttemptInfo | null): void {
    const snap = this.requireMutable(runId)
    if (!snap) return
    snap.currentAttempt = attempt
    snap.updatedAt = Date.now()
    this.commit(snap, 'attempt_update', attempt as unknown as Record<string, unknown>)
  }

  setMessageId(runId: string, messageId: string): void {
    const snap = this.requireMutable(runId)
    if (!snap) return
    snap.messageId = messageId
    snap.updatedAt = Date.now()
    this.commit(snap, 'message_bound', { messageId })
  }

  // ── Interaction ──────────────────────────────────────────

  addInteraction(interaction: PendingInteraction): void {
    const snap = this.requireMutable(interaction.runId)
    if (!snap) return
    const idx = snap.pendingInteractions.findIndex(
      i => i.interactionId === interaction.interactionId
    )
    if (idx >= 0) {
      snap.pendingInteractions[idx] = interaction
    } else {
      snap.pendingInteractions.push(interaction)
    }
    snap.updatedAt = Date.now()
    if (snap.status === 'running' || snap.status === 'retrying') {
      snap.status = 'waiting_user'
    }
    this.commit(snap, 'interaction_enqueued', {
      interactionId: interaction.interactionId,
      type: interaction.type
    })
  }

  updateInteraction(
    runId: string,
    interactionId: string,
    patch: Partial<PendingInteraction>
  ): PendingInteraction | null {
    const snap = this.requireMutable(runId)
    if (!snap) return null
    const idx = snap.pendingInteractions.findIndex(i => i.interactionId === interactionId)
    if (idx < 0) return null
    const next = { ...snap.pendingInteractions[idx], ...patch }
    snap.pendingInteractions[idx] = next
    snap.updatedAt = Date.now()
    this.commit(snap, 'interaction_updated', {
      interactionId,
      status: next.status,
      version: next.version
    })
    return { ...next }
  }

  findInteraction(interactionId: string): PendingInteraction | null {
    for (const snap of this.runs.values()) {
      const found = snap.pendingInteractions.find(i => i.interactionId === interactionId)
      if (found) return { ...found }
    }
    // 磁盘兜底
    for (const runId of this.store.listRunIds()) {
      const snap = this.store.loadSnapshot(runId)
      if (!snap) continue
      const found = snap.pendingInteractions.find(i => i.interactionId === interactionId)
      if (found) {
        this.runs.set(runId, snap)
        this.indexSession(snap.sessionId, runId)
        return { ...found }
      }
    }
    return null
  }

  listPendingInteractionsForSession(sessionId: string): PendingInteraction[] {
    const result: PendingInteraction[] = []
    const seen = new Set<string>()
    for (const snap of this.runs.values()) {
      if (snap.sessionId !== sessionId) continue
      for (const i of snap.pendingInteractions) {
        if (i.status === 'pending' || i.status === 'submitting') {
          if (!seen.has(i.interactionId)) {
            seen.add(i.interactionId)
            result.push({ ...i })
          }
        }
      }
    }
    return result
  }

  /** 无 pending 时从 waiting_user 回到 running */
  resumeFromWaitingIfClear(runId: string): void {
    const snap = this.requireMutable(runId)
    if (!snap) return
    if (snap.status !== 'waiting_user') return
    const stillPending = snap.pendingInteractions.some(
      i => i.status === 'pending' || i.status === 'submitting'
    )
    if (!stillPending) {
      this.transition(runId, 'running', 'resumed_from_waiting')
    }
  }

  // ── 工具对账（T2-5） ─────────────────────────────────────

  recordToolPhase(
    runId: string,
    toolCallId: string,
    toolName: string,
    phase: ToolCommitPhase,
    opts?: { idempotent?: boolean; checkpointRef?: string }
  ): void {
    const snap = this.requireMutable(runId)
    if (!snap) return
    const commits = snap.toolCommits ?? (snap.toolCommits = [])
    const idx = commits.findIndex(c => c.toolCallId === toolCallId)
    const record: ToolCommitRecord = {
      toolCallId,
      toolName,
      phase,
      idempotent: opts?.idempotent ?? false,
      updatedAt: Date.now(),
      ...(opts?.checkpointRef ? { checkpointRef: opts.checkpointRef } : {})
    }
    if (idx >= 0) {
      commits[idx] = { ...commits[idx], ...record }
    } else {
      commits.push(record)
    }
    snap.updatedAt = Date.now()
    this.commit(snap, 'tool_phase', {
      toolCallId,
      toolName,
      phase,
      idempotent: record.idempotent
    })
  }

  /**
   * 写入/更新执行中 turnDraft（工具边界 fsync）。
   * blocks 为当前 assistant 草稿的完整快照；finalized=true 表示已写入 SessionStore。
   */
  upsertTurnDraft(
    runId: string,
    draft: {
      messageId: string
      attemptId?: string
      blocks: Array<Record<string, unknown>>
      finalized?: boolean
    }
  ): RunSnapshot | null {
    const snap = this.requireMutable(runId)
    if (!snap) return null
    const now = Date.now()
    snap.turnDraft = {
      messageId: draft.messageId,
      attemptId: draft.attemptId ?? snap.currentAttempt?.attemptId ?? 'default',
      blocks: draft.blocks.map(b => ({ ...b })),
      finalized: draft.finalized ?? false,
      updatedAt: now
    }
    if (draft.messageId) snap.messageId = draft.messageId
    snap.updatedAt = now
    this.commit(snap, draft.finalized ? 'turn_draft_finalized' : 'turn_draft_upsert', {
      messageId: draft.messageId,
      blockCount: draft.blocks.length,
      finalized: draft.finalized ?? false
    })
    return cloneSnapshot(snap)
  }

  /** 终态后清除草稿（仅在 SessionStore 已幂等写入后调用） */
  clearTurnDraft(runId: string): void {
    const snap = this.runs.get(runId) ?? this.store.loadSnapshot(runId)
    if (!snap) return
    if (!snap.turnDraft) return
    snap.turnDraft = null
    // 终态后仍允许清草稿：绕过 requireMutable，但必须走统一 commit
    this.runs.set(runId, snap)
    this.commit(snap, 'turn_draft_cleared', {})
  }

  /** 持久化 interaction command 回执（跨重启幂等） */
  rememberCommandAck(runId: string, ack: InteractionCommandAck): void {
    const snap = this.runs.get(runId) ?? this.store.loadSnapshot(runId)
    if (!snap) return
    const list = snap.commandAcks ?? (snap.commandAcks = [])
    if (list.some(a => a.commandId === ack.commandId)) return
    list.push(ack)
    if (list.length > 200) list.splice(0, list.length - 200)
    this.runs.set(runId, snap)
    this.commit(snap, 'command_ack', {
      commandId: ack.commandId,
      ok: ack.ok,
      code: ack.code
    })
  }

  /** 查找已持久化的 command 回执 */
  findCommandAck(commandId: string): InteractionCommandAck | null {
    for (const snap of this.runs.values()) {
      const hit = snap.commandAcks?.find(a => a.commandId === commandId)
      if (hit) return hit
    }
    // 磁盘扫描（冷启动后内存未热加载时）
    for (const runId of this.store.listRunIds()) {
      const snap = this.runs.get(runId) ?? this.store.loadSnapshot(runId)
      if (!snap) continue
      this.runs.set(runId, snap)
      const hit = snap.commandAcks?.find(a => a.commandId === commandId)
      if (hit) return hit
    }
    return null
  }

  // ── 启动扫描 / 中断对账 ──────────────────────────────────

  /**
   * 启动时扫描未终态 run：标记 interrupted，不自动重放非幂等工具。
   * 返回被标记的 snapshot 列表，供 UI 提供「继续分析 / 回滚本轮 / 查看已执行步骤」。
   */
  reconcileOnStartup(): RunSnapshot[] {
    const interrupted: RunSnapshot[] = []
    for (const snap of this.store.listNonTerminalSnapshots()) {
      // 载入内存（listNonTerminal 已做事件尾部重放）
      this.runs.set(snap.runId, snap)
      this.indexSession(snap.sessionId, snap.runId)

      if (isTerminalRunStatus(snap.status)) continue

      const commits = snap.toolCommits ?? []
      for (const c of commits) {
        if ((c.phase === 'prepared' || c.phase === 'executing') && !c.idempotent) {
          c.phase = 'failed'
          c.updatedAt = Date.now()
        }
      }

      const transitionId = randomUUID()
      snap.status = 'interrupted'
      snap.terminalReason = 'process_exit'
      snap.terminalTransitionId = transitionId
      snap.executionGeneration = 0
      for (const inter of snap.pendingInteractions) {
        if (inter.status === 'pending' || inter.status === 'submitting') {
          inter.status = 'cancelled'
          inter.version += 1
        }
      }
      this.runs.set(snap.runId, snap)
      this.commit(snap, 'reconcile_interrupted', { reason: 'process_exit' })
      interrupted.push(cloneSnapshot(snap))
    }

    // 扫描终态 run 的未完成 outbox，供 handler 注册后 drain
    this.pendingOutboxOnStartup = this.collectPendingOutboxKeys()
    return interrupted
  }

  /** 启动时发现的 pending outbox keys，供 drainPendingOutbox 使用 */
  private pendingOutboxOnStartup: string[] = []

  private collectPendingOutboxKeys(): string[] {
    const keys: string[] = []
    for (const runId of this.store.listRunIds()) {
      const snap = this.runs.get(runId) ?? this.store.loadSnapshot(runId)
      if (!snap?.terminalOutbox) continue
      this.runs.set(runId, snap)
      for (const e of snap.terminalOutbox) {
        if (e.status === 'pending' || e.status === 'failed' || e.status === 'delivering') {
          keys.push(e.key)
        }
      }
    }
    return keys
  }

  // ── Terminal hooks（exactly-once） ────────────────────────

  private async fireTerminalHook(
    runId: string,
    terminalTransitionId: string,
    hookName: TerminalHookName,
    snapshot: RunSnapshot
  ): Promise<void> {
    const key = `${runId}|${terminalTransitionId}|${hookName}`
    const snap = this.runs.get(runId) ?? this.store.loadSnapshot(runId)
    const outbox = snap?.terminalOutbox ?? []
    const existing = outbox.find(e => e.key === key)
    if (existing?.status === 'delivered' || this.firedTerminalHooks.has(key)) {
      this.firedTerminalHooks.add(key)
      return
    }

    // 持久化 pending（无 handler 时保持 pending，不得标 delivered）
    if (snap && !existing) {
      const entry: TerminalOutboxEntry = {
        key,
        runId,
        terminalTransitionId,
        hookName,
        status: 'pending',
        at: Date.now(),
        idempotencyKey: key
      }
      const list = snap.terminalOutbox ?? (snap.terminalOutbox = [])
      list.push(entry)
      this.runs.set(runId, snap)
      this.commit(snap, 'terminal_outbox_pending', { key, hookName })
    }

    const handlers = this.terminalHookHandlers.get(hookName)
    if (!handlers || handlers.size === 0) {
      // 无 handler：保持 pending，等注册后 drain
      return
    }

    await this.deliverOutboxEntry(runId, key, snapshot)
  }

  /**
   * 投递单条 outbox：成功才 delivered；失败保留 pending/failed。
   * 采用 at-least-once + handler 侧 idempotencyKey 去重，不宣称 exactly-once。
   */
  private async deliverOutboxEntry(
    runId: string,
    key: string,
    snapshot: RunSnapshot
  ): Promise<void> {
    const snap = this.runs.get(runId) ?? this.store.loadSnapshot(runId)
    if (!snap?.terminalOutbox) return
    const entry = snap.terminalOutbox.find(e => e.key === key)
    if (!entry || entry.status === 'delivered') return

    const hookName = entry.hookName as TerminalHookName
    const handlers = this.terminalHookHandlers.get(hookName)
    if (!handlers || handlers.size === 0) return

    entry.status = 'delivering'
    entry.at = Date.now()
    this.runs.set(runId, snap)
    this.commit(snap, 'terminal_outbox_delivering', { key })

    const ctx: TerminalHookContext = {
      runId,
      terminalTransitionId: entry.terminalTransitionId,
      hookName,
      snapshot: cloneSnapshot(snapshot)
    }

    const errors: string[] = []
    for (const handler of handlers) {
      try {
        await handler(ctx)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(msg)
        console.error(`[RunCoordinator] terminal hook ${hookName} 失败:`, err)
      }
    }

    if (errors.length > 0) {
      entry.status = 'failed'
      entry.lastError = errors.join('; ').slice(0, 500)
      entry.at = Date.now()
      this.runs.set(runId, snap)
      this.commit(snap, 'terminal_outbox_failed', { key, error: entry.lastError })
      return
    }

    entry.status = 'delivered'
    entry.at = Date.now()
    entry.lastError = undefined
    this.firedTerminalHooks.add(key)
    this.runs.set(runId, snap)
    this.commit(snap, 'terminal_outbox_delivered', { key })
  }

  /**
   * handler 注册后或启动后：重试所有 pending/failed outbox。
   * 按 runId 绑定，避免全局 AgentLoop 串线。
   */
  async drainPendingOutbox(filterRunId?: string): Promise<number> {
    let delivered = 0
    for (const runId of this.store.listRunIds()) {
      if (filterRunId && runId !== filterRunId) continue
      const snap = this.runs.get(runId) ?? this.store.loadSnapshot(runId)
      if (!snap?.terminalOutbox) continue
      this.runs.set(runId, snap)
      for (const entry of [...snap.terminalOutbox]) {
        if (entry.status !== 'pending' && entry.status !== 'failed') continue
        await this.deliverOutboxEntry(runId, entry.key, snap)
        const after = (this.runs.get(runId) ?? snap).terminalOutbox?.find(e => e.key === entry.key)
        if (after?.status === 'delivered') delivered += 1
      }
    }
    return delivered
  }

  onTerminalHook(hookName: TerminalHookName, handler: TerminalHookHandler): () => void {
    let set = this.terminalHookHandlers.get(hookName)
    if (!set) {
      set = new Set()
      this.terminalHookHandlers.set(hookName, set)
    }
    set.add(handler)
    // 新 handler 注册后尝试 drain pending（at-least-once）
    void this.drainPendingOutbox().catch(err => {
      console.error('[RunCoordinator] drainPendingOutbox 失败:', err)
    })
    return () => {
      set!.delete(handler)
    }
  }

  /** 供外部（AgentLoop 适配）查询某 hook 是否已对当前 terminal 触发过 */
  hasFiredTerminalHook(
    runId: string,
    terminalTransitionId: string,
    hookName: TerminalHookName
  ): boolean {
    if (this.firedTerminalHooks.has(`${runId}|${terminalTransitionId}|${hookName}`)) return true
    const snap = this.runs.get(runId) ?? this.store.loadSnapshot(runId)
    const key = `${runId}|${terminalTransitionId}|${hookName}`
    return snap?.terminalOutbox?.some(e => e.key === key && e.status === 'delivered') ?? false
  }

  // ── 内部 ─────────────────────────────────────────────────

  private requireMutable(runId: string): RunSnapshot | null {
    let snap = this.runs.get(runId)
    if (!snap) {
      const loaded = this.store.loadSnapshot(runId)
      if (!loaded) return null
      this.runs.set(runId, loaded)
      this.indexSession(loaded.sessionId, runId)
      snap = loaded
    }
    // 硬终态不可变；interrupted 允许 → resuming
    if (isHardTerminalRunStatus(snap.status)) return null
    return snap
  }

  private commit(
    snapshot: RunSnapshot,
    eventType: string,
    payload?: Record<string, unknown>
  ): void {
    // 唯一落盘入口：先递增 sequence，再 event→fsync→atomic snapshot→broadcast
    snapshot.sequence += 1
    snapshot.updatedAt = Date.now()
    this.runs.set(snapshot.runId, snapshot)
    this.indexSession(snapshot.sessionId, snapshot.runId)
    const event = this.store.commitTransaction(snapshot, eventType, payload)
    this.onSnapshot?.(cloneSnapshot(snapshot), event)
  }

  /**
   * 绑定执行 generation（权威 fencing）。
   * 副作用入口用 isExecutionCurrent 校验。
   */
  bindExecutionGeneration(runId: string, generation: number): RunSnapshot | null {
    const snap = this.requireMutable(runId)
    if (!snap) return null
    snap.executionGeneration = generation
    this.commit(snap, 'execution_generation', { executionGeneration: generation })
    return cloneSnapshot(snap)
  }

  /**
   * 使当前 executionGeneration 失效（grace 超时 / 强制中断）。
   * 旧 continuation 不得再写文件或提交工具结果。
   */
  invalidateExecutionGeneration(runId: string): RunSnapshot | null {
    const snap = this.runs.get(runId) ?? this.store.loadSnapshot(runId)
    if (!snap) return null
    const prev = snap.executionGeneration
    // 清零表示无有效 generation；保留 prev 在事件里便于审计
    snap.executionGeneration = 0
    snap.updatedAt = Date.now()
    this.runs.set(runId, snap)
    this.commit(snap, 'execution_generation_invalidated', {
      previousGeneration: prev ?? null
    })
    return cloneSnapshot(snap)
  }

  /** 统一 fencing 检查：run 存在且 generation 与权威 snapshot 一致且非 0 */
  isExecutionCurrent(runId: string, generation: number): boolean {
    if (!generation || generation <= 0) return false
    const snap = this.runs.get(runId) ?? this.store.loadSnapshot(runId)
    if (!snap) return false
    return snap.executionGeneration === generation
  }

  private indexSession(sessionId: string, runId: string): void {
    let set = this.sessionIndex.get(sessionId)
    if (!set) {
      set = new Set()
      this.sessionIndex.set(sessionId, set)
    }
    set.add(runId)
  }
}

function cloneSnapshot(snap: RunSnapshot): RunSnapshot {
  return {
    ...snap,
    pendingInteractions: snap.pendingInteractions.map(i => ({ ...i, payload: { ...i.payload } })),
    currentAttempt: snap.currentAttempt ? { ...snap.currentAttempt } : null,
    progress: snap.progress ? { ...snap.progress } : null,
    toolCommits: snap.toolCommits?.map(c => ({ ...c })),
    turnDraft: snap.turnDraft
      ? {
          ...snap.turnDraft,
          blocks: snap.turnDraft.blocks.map(b => ({ ...b }))
        }
      : snap.turnDraft,
    commandAcks: snap.commandAcks?.map(a => ({ ...a })),
    terminalOutbox: snap.terminalOutbox?.map(e => ({ ...e }))
  }
}

function mapTerminalToHook(status: RunStatus): TerminalHookName | null {
  switch (status) {
    case 'cancelled':
      return 'onCancel'
    case 'completed':
      return 'onComplete'
    case 'failed':
      return 'onFail'
    case 'interrupted':
      return 'onInterrupt'
    default:
      return null
  }
}

/** 工厂：便于测试与主进程单例 */
export function createRunCoordinator(runsRoot: string, onSnapshot?: RunSnapshotListener): RunCoordinator {
  return new RunCoordinator({
    store: new RunStore({ runsRoot }),
    onSnapshot
  })
}

export type { RunKind }
