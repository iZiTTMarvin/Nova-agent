import { randomUUID } from 'crypto'
import {
  deriveSubagentNotificationId,
  isTerminalRunStatus,
  SUBAGENT_RELAY_TRIGGER_VERSION,
  type RunSnapshot,
  type SubagentRelayTrigger
} from '../../shared/run/types'
import { RUNTIME_INPUT_VERSION, type RuntimeInputBlock } from '../../shared/session/types'
import type { ChatMessage } from '../model/types'
import type { RunCoordinator } from '../run'
import type { SessionStore } from '../sessions'
import {
  MAX_SUBAGENT_SUMMARY_CHARS,
  projectSubagentExecutionResult
} from './resultProjection'
import { describeIncompleteReason, statusLabel } from './resultText'

const MAX_BATCH_ITEMS = 8
const MAX_BATCH_CHARS = 8_000
const MAX_TURN_BATCHES = 3

/** 同一用户派遣链上的自动接力上限；耗尽后由用户继续。 */
export const MAX_RELAY_TURNS_PER_CHAIN = 3

export interface RuntimeInputPersistencePort {
  persist(
    messageId: string,
    input: RuntimeInputBlock
  ): { notificationId: string } | Promise<{ notificationId: string }>
}

export interface ActiveSubagentDeliveryReceiver {
  receive(input: { messageId: string; afterStep: number }): Promise<readonly ChatMessage[]>
}

/** 空闲接力的接纳结果：runId 即预约 id，重复接纳返回同一预约。 */
export interface SubagentRelayAdmission {
  readonly relayRunId: string
}

export interface SubagentDeliveryCoordinatorDeps {
  readonly runCoordinator: Pick<RunCoordinator,
    | 'getSnapshot' | 'listDispatchSnapshots' | 'listRelayTriggerSnapshots'
    | 'listSnapshotsForSession' | 'updateDeliveryBinding' | 'startRun' | 'commitTerminal'>
  readonly sessionStore: Pick<SessionStore, 'findRuntimeInputFact' | 'load' | 'appendMessageFast'>
  readonly isRunExecutionActive: (runId: string) => boolean
  /** 空闲会话收到新通知时的回调，用于触发自动接力。 */
  readonly onIdleRelayAvailable?: (sessionId: string) => void
}

/** srcRunId 的投递分类：接收凭据 / 被接力预约占用 / 不再接纳 / 可投递。 */
type SourceClassification = 'received' | 'reserved' | 'suppressed' | 'eligible'

/** 从终态派遣事实派生通知候选；内存索引可丢弃，接收凭据仍在会话消息中。 */
export class SubagentDeliveryCoordinator {
  private readonly pendingBySession = new Map<string, Set<string>>()
  private readonly drains = new Map<string, { recheck: boolean; promise: Promise<readonly ChatMessage[]> }>()
  /** 每会话的接力预约 runId；持久快照是权威，索引只是热缓存。 */
  private readonly reservationsBySession = new Map<string, Set<string>>()
  /** 构造期只建索引，不回放唤醒回调，避免在依赖的提交栈内重入。 */
  private acceptLiveCallbacks = false

  constructor(private readonly deps: SubagentDeliveryCoordinatorDeps) {
    for (const snapshot of deps.runCoordinator.listDispatchSnapshots()) {
      this.noteTerminal(snapshot)
    }
    this.acceptLiveCallbacks = true
  }

  noteTerminal(snapshot: RunSnapshot): void {
    if (!isEligibleSource(snapshot)) return
    const sessionId = snapshot.dispatch!.parentSessionId
    let pending = this.pendingBySession.get(sessionId)
    if (!pending) {
      pending = new Set()
      this.pendingBySession.set(sessionId, pending)
    }
    pending.add(snapshot.runId)
    const drain = this.drains.get(sessionId)
    if (drain) drain.recheck = true
    // 空闲接力：微任务逃出 terminal hook 派发栈，避免在 commitTerminal 内同步重入协调器
    if (this.acceptLiveCallbacks && !drain && !this.deps.isRunExecutionActive(snapshot.runId)) {
      queueMicrotask(() => this.deps.onIdleRelayAvailable?.(sessionId))
    }
  }

  noteExecutionSettled(runId: string): void {
    const snapshot = this.deps.runCoordinator.getSnapshot(runId)
    if (snapshot) this.noteTerminal(snapshot)
  }

  createActiveTurnReceiver(input: {
    readonly sessionId: string
    readonly runId: () => string
    readonly persistence: RuntimeInputPersistencePort
  }): ActiveSubagentDeliveryReceiver {
    let acceptedBatches = 0
    const acceptedIds = new Set<string>()

    return {
      receive: boundary => this.runSessionDrain(input.sessionId, async () => {
        if (acceptedBatches >= MAX_TURN_BATCHES) return []
        const runId = input.runId()
        if (!runId) return []
        const candidates = this.selectCandidates(input.sessionId, runId, acceptedIds)
        if (candidates.length === 0) return []

        const selected = buildBatch(candidates, this.deps.sessionStore)
        if (selected.length === 0) return []
        const startOrder = this.nextOrder(runId, boundary.messageId, boundary.afterStep)
        const messages: ChatMessage[] = []

        for (let index = 0; index < selected.length; index++) {
          const item = selected[index]
          const block: RuntimeInputBlock = {
            type: 'runtime_input',
            version: 1,
            inputKind: 'subagent_notification',
            notificationId: item.notificationId,
            sourceRunId: item.snapshot.runId,
            afterStep: boundary.afterStep,
            order: startOrder + index,
            content: item.content
          }
          const receipt = await input.persistence.persist(boundary.messageId, block)
          if (receipt.notificationId !== block.notificationId) {
            throw new Error('runtime_input persistence receipt does not match notification')
          }
          acceptedIds.add(item.notificationId)
          this.removePending(input.sessionId, item.snapshot.runId)
          messages.push({
            role: 'user',
            content: block.content,
            contextInstruction: true,
            origin: {
              messageId: boundary.messageId,
              step: Math.max(0, boundary.afterStep),
              runtimeInputId: block.notificationId
            }
          })
        }
        acceptedBatches += 1
        return messages
      })
    }
  }

  /**
   * 空闲会话接纳一次自动接力：先持久 queued 预约（冻结通知集合），再补绑与补接力消息。
   * 全同步短临界区，不发起 run 执行（执行由主进程接管）。
   */
  admitIdleRelay(sessionId: string): SubagentRelayAdmission | null {
    const live = this.findLiveReservation(sessionId)
    if (live) return this.materializeReservation(live)
    const candidates = this.selectRelayCandidates(sessionId)
    if (candidates.length === 0) return null
    const session = this.deps.sessionStore.load(sessionId)
    if (!session) return null

    const originUserMessageId =
      candidates[0].dispatch!.originUserMessageId ?? candidates[0].dispatch!.parentMessageId
    // 预算从已持久 trigger 派生：同一发起用户消息链上最多 MAX_RELAY_TURNS_PER_CHAIN 次接力
    const chainTurns = this.deps.runCoordinator
      .listSnapshotsForSession(sessionId)
      .filter(snapshot => snapshot.relayTrigger?.originUserMessageId === originUserMessageId).length
    if (chainTurns >= MAX_RELAY_TURNS_PER_CHAIN) {
      console.info(
        `[SubagentDeliveryCoordinator] 接力预算耗尽等待用户继续 session=${sessionId} origin=${originUserMessageId}`
      )
      return null
    }

    const sameChain = candidates.filter(
      snapshot =>
        (snapshot.dispatch!.originUserMessageId ?? snapshot.dispatch!.parentMessageId) ===
        originUserMessageId
    )
    const batch = buildBatch(sameChain, this.deps.sessionStore)
    if (batch.length === 0) return null

    const relayRunId = randomUUID()
    const trigger: SubagentRelayTrigger = {
      version: SUBAGENT_RELAY_TRIGGER_VERSION,
      requestId: relayRunId,
      receiveMessageId: `msg_relay_${relayRunId}`,
      originUserMessageId,
      anchorMessageId: session.currentLeafId ?? null,
      items: batch.map(item => ({
        notificationId: item.notificationId,
        sourceRunId: item.snapshot.runId,
        content: item.content
      })),
      createdAt: Date.now()
    }
    const snapshot = this.deps.runCoordinator.startRun({
      kind: 'agent',
      workspaceId: session.workspaceRoot,
      sessionId,
      runId: relayRunId,
      messageId: trigger.receiveMessageId,
      relayTrigger: trigger
    })
    this.addReservation(sessionId, snapshot.runId)
    return this.materializeReservation(snapshot)
  }

  settleRelayReservation(runId: string, status: 'cancelled' | 'failed', reason: string): void {
    const snapshot = this.deps.runCoordinator.getSnapshot(runId)
    if (!snapshot || isTerminalRunStatus(snapshot.status)) return
    this.deps.runCoordinator.commitTerminal({ runId, status, reason })

    // 未执行即取消（用户取代 / 会话删除）恢复通知资格；已执行或 failed 保留绑定，
    // 只等用户继续时重新投递，不自动再接纳。
    if (status === 'cancelled' && !snapshot.turnStartedAt && snapshot.relayTrigger) {
      for (const item of snapshot.relayTrigger.items) {
        if (this.deps.runCoordinator.getSnapshot(item.sourceRunId)?.deliveryBinding?.boundRunId !== runId) {
          continue
        }
        this.deps.runCoordinator.updateDeliveryBinding(item.sourceRunId, {
          boundRunId: undefined,
          boundSessionId: undefined
        })
      }
    }
    this.removeReservation(snapshot.sessionId, runId)
  }

  /** 用户消息取代同会话全部未执行的接力预约。 */
  supersedeQueuedRelayReservations(sessionId: string): void {
    for (const snapshot of this.queuedReservations(sessionId)) {
      this.settleRelayReservation(snapshot.runId, 'cancelled', 'superseded_by_user_message')
    }
  }

  /** 会话删除前结算其未执行的接力预约。 */
  settleQueuedRelayReservationsForSessions(sessionIds: Iterable<string>): void {
    for (const sessionId of sessionIds) {
      for (const snapshot of this.queuedReservations(sessionId)) {
        this.settleRelayReservation(snapshot.runId, 'cancelled', 'session_deleted')
      }
    }
  }

  /**
   * 启动对账：补齐预约绑定与接力消息，并解绑指向「不存在」或「未执行即取消」run 的源绑定。
   * 返回仍有有效预约的会话 id。
   */
  reconcileDeliveryOnStartup(): string[] {
    const awaiting = new Set<string>()
    for (const snapshot of this.deps.runCoordinator.listRelayTriggerSnapshots()) {
      if (!isQueuedReservation(snapshot)) continue
      this.addReservation(snapshot.sessionId, snapshot.runId)
      if (this.materializeReservation(snapshot)) awaiting.add(snapshot.sessionId)
    }
    for (const snapshot of this.deps.runCoordinator.listDispatchSnapshots()) {
      try {
        this.releaseStaleBinding(snapshot)
      } catch (err) {
        console.error(
          `[SubagentDeliveryCoordinator] 解绑失效投递绑定失败 runId=${snapshot.runId}:`,
          err
        )
      }
    }
    return [...awaiting]
  }

  /** 待处理通知或有效预约所在的会话：供启动后补触发自动接力。 */
  listSessionsAwaitingRelay(): string[] {
    const sessions = new Set<string>()
    for (const [sessionId, pending] of this.pendingBySession) {
      if (pending.size > 0) sessions.add(sessionId)
    }
    for (const sessionId of [...this.reservationsBySession.keys()]) {
      if (this.findLiveReservation(sessionId)) sessions.add(sessionId)
    }
    return [...sessions]
  }

  private async runSessionDrain(
    sessionId: string,
    work: () => Promise<readonly ChatMessage[]>
  ): Promise<readonly ChatMessage[]> {
    const active = this.drains.get(sessionId)
    if (active) {
      active.recheck = true
      await active.promise
      return []
    }

    const state = {
      recheck: false,
      promise: Promise.resolve<readonly ChatMessage[]>([])
    }
    state.promise = (async () => {
      do {
        state.recheck = false
        const received = await work()
        if (received.length > 0) return received
      } while (state.recheck)
      return []
    })()
    this.drains.set(sessionId, state)
    try {
      return await state.promise
    } finally {
      if (this.drains.get(sessionId) === state) this.drains.delete(sessionId)
    }
  }

  private selectCandidates(
    sessionId: string,
    runId: string,
    acceptedIds: ReadonlySet<string>
  ): RunSnapshot[] {
    const result: RunSnapshot[] = []
    this.scanPending(sessionId, acceptedIds, ({ snapshot, sourceRunId, classification }) => {
      if (classification === 'received') {
        this.deps.runCoordinator.updateDeliveryBinding(sourceRunId, {
          boundRunId: snapshot.deliveryBinding?.boundRunId ?? runId,
          boundSessionId: sessionId
        })
        this.removePending(sessionId, sourceRunId)
        return
      }
      if (classification === 'suppressed' || classification === 'reserved') {
        // reserved：接力预约占用中，保留 pending 等接管或用户取代
        if (classification === 'suppressed') this.removePending(sessionId, sourceRunId)
        return
      }
      this.releaseStaleBinding(snapshot)
      result.push(snapshot)
    })
    return sortCandidates(result)
  }

  private selectRelayCandidates(sessionId: string): RunSnapshot[] {
    const result: RunSnapshot[] = []
    this.scanPending(sessionId, EMPTY_ACCEPTED_IDS, ({ sourceRunId, classification, snapshot }) => {
      if (classification === 'received') {
        this.removePending(sessionId, sourceRunId)
        return
      }
      if (classification === 'suppressed' || classification === 'reserved') {
        if (classification === 'suppressed') this.removePending(sessionId, sourceRunId)
        return
      }
      this.releaseStaleBinding(snapshot)
      result.push(snapshot)
    })
    return sortCandidates(result)
  }

  private scanPending(
    sessionId: string,
    acceptedIds: ReadonlySet<string>,
    visit: (input: {
      snapshot: RunSnapshot
      sourceRunId: string
      classification: SourceClassification
    }) => void
  ): void {
    const pending = this.pendingBySession.get(sessionId)
    if (!pending || pending.size === 0) return
    for (const sourceRunId of [...pending]) {
      const snapshot = this.deps.runCoordinator.getSnapshot(sourceRunId)
      if (!snapshot || !isEligibleSource(snapshot)) {
        this.removePending(sessionId, sourceRunId)
        continue
      }
      if (this.deps.isRunExecutionActive(sourceRunId)) continue
      const notificationId = deriveSubagentNotificationId(sourceRunId, snapshot.terminalTransitionId!)
      if (acceptedIds.has(notificationId)) continue
      visit({
        snapshot,
        sourceRunId,
        classification: this.classifySource(sessionId, snapshot, notificationId)
      })
    }
  }

  /** 纯读分类，不写状态；绑定目标丢失留给调用方解绑后重新接纳。 */
  private classifySource(
    sessionId: string,
    sourceSnapshot: RunSnapshot,
    notificationId: string
  ): SourceClassification {
    if (this.deps.sessionStore.findRuntimeInputFact(sessionId, notificationId)) return 'received'
    const binding = sourceSnapshot.deliveryBinding
    const boundRunId = binding?.boundRunId
    if (!boundRunId) {
      return binding?.boundSessionId && binding.boundSessionId !== sessionId
        ? 'suppressed'
        : 'eligible'
    }
    const bound = this.deps.runCoordinator.getSnapshot(boundRunId)
    if (!bound) return 'eligible'
    if (!isTerminalRunStatus(bound.status)) return 'reserved'
    if (bound.turnStartedAt) return 'suppressed'
    return bound.status === 'cancelled' ? 'eligible' : 'suppressed'
  }

  /** 解绑指向「不存在」或「未执行即取消」run 的源绑定，其余情况不动。 */
  private releaseStaleBinding(snapshot: RunSnapshot): void {
    const boundRunId = snapshot.deliveryBinding?.boundRunId
    if (!boundRunId) return
    const bound = this.deps.runCoordinator.getSnapshot(boundRunId)
    if (bound && !(bound.status === 'cancelled' && !bound.turnStartedAt)) return
    this.deps.runCoordinator.updateDeliveryBinding(snapshot.runId, {
      boundRunId: undefined,
      boundSessionId: undefined
    })
  }

  private findLiveReservation(sessionId: string): RunSnapshot | null {
    const indexed = this.reservationsBySession.get(sessionId)
    // 复制后再遍历：惰性清理会写索引，不在迭代中原地删
    for (const runId of [...(indexed ?? [])]) {
      const snapshot = this.deps.runCoordinator.getSnapshot(runId)
      if (snapshot && isQueuedReservation(snapshot)) return snapshot
      this.removeReservation(sessionId, runId)
    }
    // 冷启动 / 跨实例：内存索引为空时回退持久层，复用同一预约而不是另开一个
    const persisted = this.deps.runCoordinator
      .listSnapshotsForSession(sessionId)
      .find(isQueuedReservation)
    if (!persisted) return null
    this.addReservation(sessionId, persisted.runId)
    return persisted
  }

  /**
   * 预约持久化后补齐派生事实：源绑定与携带冻结块的内部接力消息。
   * 两步都幂等，可重试；任一步失败即带原因结算该预约。
   */
  private materializeReservation(snapshot: RunSnapshot): SubagentRelayAdmission | null {
    const trigger = snapshot.relayTrigger
    if (!trigger) return null
    const session = this.deps.sessionStore.load(snapshot.sessionId)
    if (!session) {
      this.settleRelayReservation(snapshot.runId, 'failed', 'relay_session_missing')
      return null
    }

    const items = trigger.items.filter(item => {
      const source = this.deps.runCoordinator.getSnapshot(item.sourceRunId)
      return Boolean(source) && !source!.deliveryBinding?.invalidatedReason
    })
    if (items.length === 0) {
      this.settleRelayReservation(snapshot.runId, 'cancelled', 'relay_items_invalidated')
      return null
    }

    for (const item of items) {
      const source = this.deps.runCoordinator.getSnapshot(item.sourceRunId)
      if (!source || source.deliveryBinding?.boundRunId === snapshot.runId) continue
      this.deps.runCoordinator.updateDeliveryBinding(item.sourceRunId, {
        boundRunId: snapshot.runId,
        boundSessionId: snapshot.sessionId
      })
    }

    const appended = this.deps.sessionStore.appendMessageFast(snapshot.sessionId, {
      id: trigger.receiveMessageId,
      role: 'user',
      content: '',
      blocks: items.map((item, index) => ({
        type: 'runtime_input' as const,
        version: RUNTIME_INPUT_VERSION,
        inputKind: 'subagent_notification' as const,
        notificationId: item.notificationId,
        sourceRunId: item.sourceRunId,
        afterStep: -1,
        order: index,
        content: item.content
      })),
      internalSource: 'runtime_input',
      timestamp: trigger.createdAt
    })
    if (!appended.ok) {
      this.settleRelayReservation(
        snapshot.runId,
        'failed',
        `relay_message_persist_failed: ${appended.error}`
      )
      return null
    }
    return { relayRunId: snapshot.runId }
  }

  private nextOrder(runId: string, messageId: string, afterStep: number): number {
    const draft = this.deps.runCoordinator.getSnapshot(runId)?.turnDraft
    if (!draft || draft.messageId !== messageId) return 0
    let max = -1
    for (const block of draft.blocks) {
      if (block.type === 'runtime_input' && block.afterStep === afterStep) {
        max = Math.max(max, block.order)
      }
    }
    return max + 1
  }

  private removePending(sessionId: string, runId: string): void {
    const pending = this.pendingBySession.get(sessionId)
    if (!pending) return
    pending.delete(runId)
    if (pending.size === 0) this.pendingBySession.delete(sessionId)
  }

  private queuedReservations(sessionId: string): RunSnapshot[] {
    return this.deps.runCoordinator.listSnapshotsForSession(sessionId).filter(isQueuedReservation)
  }

  private addReservation(sessionId: string, runId: string): void {
    let set = this.reservationsBySession.get(sessionId)
    if (!set) {
      set = new Set()
      this.reservationsBySession.set(sessionId, set)
    }
    set.add(runId)
  }

  private removeReservation(sessionId: string, runId: string): void {
    const set = this.reservationsBySession.get(sessionId)
    if (!set) return
    set.delete(runId)
    if (set.size === 0) this.reservationsBySession.delete(sessionId)
  }
}

const EMPTY_ACCEPTED_IDS: ReadonlySet<string> = new Set()

/** 未执行（无 turnStartedAt）的 queued 接力预约；一旦执行即不再算预约。 */
function isQueuedReservation(snapshot: RunSnapshot): boolean {
  return Boolean(snapshot.relayTrigger && snapshot.status === 'queued' && !snapshot.turnStartedAt)
}

function sortCandidates(candidates: RunSnapshot[]): RunSnapshot[] {
  return candidates.sort((left, right) =>
    left.updatedAt - right.updatedAt || left.runId.localeCompare(right.runId)
  )
}

function isEligibleSource(snapshot: RunSnapshot): boolean {
  return Boolean(
    snapshot.dispatch?.execution === 'background_read_only' &&
    snapshot.terminalTransitionId &&
    isTerminalRunStatus(snapshot.status) &&
    snapshot.status !== 'interrupted' &&
    !snapshot.deliveryBinding?.paused &&
    !snapshot.deliveryBinding?.invalidatedReason
  )
}

function buildBatch(
  snapshots: readonly RunSnapshot[],
  sessionStore: Pick<SessionStore, 'load'>
): Array<{ snapshot: RunSnapshot; notificationId: string; content: string }> {
  const result: Array<{ snapshot: RunSnapshot; notificationId: string; content: string }> = []
  let remaining = MAX_BATCH_CHARS
  for (const snapshot of snapshots.slice(0, MAX_BATCH_ITEMS)) {
    const childSession = sessionStore.load(snapshot.sessionId)
    if (!childSession) continue
    const notificationId = deriveSubagentNotificationId(snapshot.runId, snapshot.terminalTransitionId!)
    const projected = projectSubagentExecutionResult({ childSession, runSnapshot: snapshot })
    const heading = [
      '[后台子任务通知]',
      `notification_id: ${notificationId}`,
      `child_run_id: ${snapshot.runId}`,
      `status: ${statusLabel(projected.status)}${describeIncompleteReason(projected.incompleteReason)}`,
      'summary:'
    ].join('\n')
    const truncation = '\n[摘要已截断；使用 subagent_read 读取完整结果]'
    const minimum = heading.length + truncation.length
    if (remaining < minimum) break
    let summary = projected.summary.slice(0, MAX_SUBAGENT_SUMMARY_CHARS)
    let content = `${heading}\n${summary}`
    if (content.length > remaining) {
      const available = Math.max(0, remaining - heading.length - truncation.length - 1)
      summary = summary.slice(0, available)
      content = `${heading}\n${summary}${truncation}`
    }
    result.push({ snapshot, notificationId, content })
    remaining -= content.length
  }
  return result
}
