import {
  deriveSubagentNotificationId,
  isTerminalRunStatus,
  type RunSnapshot
} from '../../shared/run/types'
import type { RuntimeInputBlock } from '../../shared/session/types'
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

export interface RuntimeInputPersistencePort {
  persist(
    messageId: string,
    input: RuntimeInputBlock
  ): { notificationId: string } | Promise<{ notificationId: string }>
}

export interface ActiveSubagentDeliveryReceiver {
  receive(input: { messageId: string; afterStep: number }): Promise<readonly ChatMessage[]>
}

export interface SubagentDeliveryCoordinatorDeps {
  readonly runCoordinator: Pick<RunCoordinator, 'getSnapshot' | 'listDispatchSnapshots' | 'updateDeliveryBinding'>
  readonly sessionStore: Pick<SessionStore, 'findRuntimeInputFact' | 'load'>
  readonly isRunExecutionActive: (runId: string) => boolean
}

/** 从终态派遣事实派生通知候选；内存索引可丢弃，接收凭据仍在会话消息中。 */
export class SubagentDeliveryCoordinator {
  private readonly pendingBySession = new Map<string, Set<string>>()
  private readonly drains = new Map<string, { recheck: boolean; promise: Promise<readonly ChatMessage[]> }>()

  constructor(private readonly deps: SubagentDeliveryCoordinatorDeps) {
    for (const snapshot of deps.runCoordinator.listDispatchSnapshots()) {
      this.noteTerminal(snapshot)
    }
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
    const pending = this.pendingBySession.get(sessionId)
    if (!pending || pending.size === 0) return []
    const result: RunSnapshot[] = []
    for (const sourceRunId of pending) {
      const snapshot = this.deps.runCoordinator.getSnapshot(sourceRunId)
      if (!snapshot || !isEligibleSource(snapshot)) {
        this.removePending(sessionId, sourceRunId)
        continue
      }
      if (this.deps.isRunExecutionActive(sourceRunId)) continue
      const notificationId = deriveSubagentNotificationId(sourceRunId, snapshot.terminalTransitionId!)
      if (acceptedIds.has(notificationId)) continue
      const received = this.deps.sessionStore.findRuntimeInputFact(sessionId, notificationId)
      if (received) {
        this.deps.runCoordinator.updateDeliveryBinding(sourceRunId, {
          boundRunId: snapshot.deliveryBinding?.boundRunId ?? runId,
          boundSessionId: sessionId
        })
        this.removePending(sessionId, sourceRunId)
        continue
      }
      const binding = snapshot.deliveryBinding
      if (
        (binding?.boundRunId && binding.boundRunId !== runId) ||
        (binding?.boundSessionId && binding.boundSessionId !== sessionId)
      ) {
        this.removePending(sessionId, sourceRunId)
        continue
      }
      result.push(snapshot)
    }
    return result.sort((left, right) =>
      left.updatedAt - right.updatedAt || left.runId.localeCompare(right.runId)
    )
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
