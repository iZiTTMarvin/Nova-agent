/**
 * InteractionInbox — 持久化挂起交互
 *
 * 每个 pending interaction 含稳定 interactionId、run/session/message 归属、类型与状态。
 * 状态写入 RunStore（经 RunCoordinator），不只在内存 Map。
 * commandId 回执同时写入 snapshot.commandAcks，跨进程重启仍幂等。
 *
 * 禁止：给所有问题一律加自动 timeout。等待用户不是故障。
 */
import { randomUUID } from 'crypto'
import type { RunCoordinator } from './RunCoordinator'
import type {
  InteractionAnswerCommand,
  InteractionAnswerResult,
  InteractionCommandAck,
  InteractionStatus,
  InteractionType,
  PendingInteraction,
  RunSnapshot
} from '../../shared/run/types'

export interface EnqueueInteractionParams {
  runId: string
  sessionId: string
  messageId: string
  type: InteractionType
  /** 稳定 id；缺省生成 */
  interactionId?: string
  payload: Record<string, unknown>
  /** 可选过期；普通 ask/permission 不要传 */
  expiresAt?: number
}

export class InteractionInbox {
  private readonly coordinator: RunCoordinator
  /** commandId → 已处理结果（热路径缓存；权威在 snapshot.commandAcks） */
  private readonly answeredCommands = new Map<string, InteractionAnswerResult>()

  constructor(coordinator: RunCoordinator) {
    this.coordinator = coordinator
  }

  /** 入队并持久化；同时把 run 切到 waiting_user（若仍在 running） */
  enqueue(params: EnqueueInteractionParams): PendingInteraction {
    const interaction: PendingInteraction = {
      interactionId: params.interactionId ?? randomUUID(),
      runId: params.runId,
      sessionId: params.sessionId,
      messageId: params.messageId,
      type: params.type,
      status: 'pending',
      createdAt: Date.now(),
      ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
      payload: params.payload,
      version: 1
    }
    this.coordinator.addInteraction(interaction)
    return interaction
  }

  /** 按 interactionId 查找（跨 run 扫描内存索引） */
  find(interactionId: string): PendingInteraction | null {
    return this.coordinator.findInteraction(interactionId)
  }

  /** 列出某会话所有 pending 交互（含其他 run） */
  listPendingForSession(sessionId: string): PendingInteraction[] {
    return this.coordinator.listPendingInteractionsForSession(sessionId)
  }

  /**
   * 幂等回答：commandId + expectedVersion。
   * 相同 commandId 重复到达时返回第一次完整 ACK（firstApplied=false），
   * 调用方不得再执行 resolver / AgentLoop 副作用。
   */
  answer(cmd: InteractionAnswerCommand): InteractionAnswerResult {
    const cached = this.answeredCommands.get(cmd.commandId)
    if (cached) {
      return { ...cached, firstApplied: false, duplicate: true }
    }

    // 跨重启：从 snapshot.commandAcks 恢复
    const durable = this.coordinator.findCommandAck(cmd.commandId)
    if (durable) {
      const rebuilt = this.rebuildResultFromAck(durable, cmd.interactionId)
      const dup = { ...rebuilt, firstApplied: false as const, duplicate: true as const }
      this.answeredCommands.set(cmd.commandId, dup)
      return dup
    }

    const found = this.coordinator.findInteraction(cmd.interactionId)
    if (!found) {
      return this.cacheAndPersist(cmd, {
        ok: false,
        code: 'not_found',
        message: `交互 ${cmd.interactionId} 不存在`,
        firstApplied: true
      })
    }

    const snap = this.coordinator.getSnapshot(found.runId)
    if (!snap) {
      return this.cacheAndPersist(cmd, {
        ok: false,
        code: 'not_found',
        message: `run ${found.runId} 不存在`,
        firstApplied: true
      }, found.runId)
    }

    if (found.status === 'answered' || found.status === 'dismissed' || found.status === 'cancelled') {
      return this.cacheAndPersist(cmd, {
        ok: false,
        code: 'already_answered',
        message: `交互已处理（status=${found.status}）`,
        snapshot: snap,
        firstApplied: true
      }, found.runId)
    }

    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled') {
      return this.cacheAndPersist(cmd, {
        ok: false,
        code: 'run_ended',
        message: `run 已结束（status=${snap.status}）`,
        snapshot: snap,
        firstApplied: true
      }, found.runId)
    }

    if (found.version !== cmd.expectedVersion) {
      return this.cacheAndPersist(cmd, {
        ok: false,
        code: 'version_mismatch',
        message: `版本不匹配：期望 ${cmd.expectedVersion}，实际 ${found.version}`,
        snapshot: snap,
        firstApplied: true
      }, found.runId)
    }

    const nextStatus: InteractionStatus =
      cmd.outcome === 'dismissed' ? 'dismissed' : 'answered'

    const updated = this.coordinator.updateInteraction(found.runId, cmd.interactionId, {
      status: nextStatus,
      version: found.version + 1,
      payload: {
        ...found.payload,
        ...(cmd.payload ?? {}),
        answerCommandId: cmd.commandId
      }
    })

    if (!updated) {
      return this.cacheAndPersist(cmd, {
        ok: false,
        code: 'not_found',
        message: '更新交互失败',
        firstApplied: true
      }, found.runId)
    }

    this.coordinator.resumeFromWaitingIfClear(found.runId)

    const nextSnap = this.coordinator.getSnapshot(found.runId)!
    return this.cacheAndPersist(cmd, {
      ok: true,
      interaction: updated,
      snapshot: nextSnap,
      firstApplied: true
    }, found.runId)
  }

  /** 取消某 run 上全部 pending（cancel 路径） */
  cancelAllForRun(runId: string): void {
    const snap = this.coordinator.getSnapshot(runId)
    if (!snap) return
    for (const inter of snap.pendingInteractions) {
      if (inter.status === 'pending' || inter.status === 'submitting') {
        this.coordinator.updateInteraction(runId, inter.interactionId, {
          status: 'cancelled',
          version: inter.version + 1
        })
      }
    }
  }

  /** 从 snapshot 投影当前会话应展示的交互（供测试 / 诊断） */
  projectPendingFromSnapshot(snapshot: RunSnapshot): PendingInteraction[] {
    return snapshot.pendingInteractions.filter(
      i => i.status === 'pending' || i.status === 'submitting'
    )
  }

  private cacheAndPersist(
    cmd: InteractionAnswerCommand,
    result: InteractionAnswerResult,
    runId?: string
  ): InteractionAnswerResult {
    this.answeredCommands.set(cmd.commandId, result)
    const targetRunId =
      runId ??
      (result.ok ? result.snapshot.runId : result.snapshot?.runId) ??
      this.coordinator.findInteraction(cmd.interactionId)?.runId
    if (targetRunId) {
      const ack: InteractionCommandAck = {
        commandId: cmd.commandId,
        interactionId: cmd.interactionId,
        at: Date.now(),
        ok: result.ok,
        ...(result.ok ? {} : { code: result.code, message: result.message })
      }
      this.coordinator.rememberCommandAck(targetRunId, ack)
    }
    return result
  }

  private rebuildResultFromAck(
    ack: InteractionCommandAck,
    interactionId: string
  ): InteractionAnswerResult {
    const inter = this.coordinator.findInteraction(ack.interactionId || interactionId)
    const snap = inter ? this.coordinator.getSnapshot(inter.runId) : null
    if (ack.ok && inter && snap) {
      return {
        ok: true,
        interaction: inter,
        snapshot: snap,
        firstApplied: false,
        duplicate: true
      }
    }
    // 成功 ACK 但交互已从 snapshot 投影不到时：仍返回 ok，避免二次副作用
    if (ack.ok && snap) {
      return {
        ok: true,
        interaction: {
          interactionId: ack.interactionId || interactionId,
          runId: snap.runId,
          sessionId: snap.sessionId,
          messageId: snap.messageId,
          type: 'askQuestion',
          status: 'answered',
          createdAt: ack.at,
          payload: {},
          version: 0
        },
        snapshot: snap,
        firstApplied: false,
        duplicate: true
      }
    }
    const code =
      (ack.code as
        | 'already_answered'
        | 'run_ended'
        | 'not_found'
        | 'version_mismatch'
        | 'duplicate_command'
        | undefined) ?? 'duplicate_command'
    return {
      ok: false,
      code,
      message: ack.message ?? '命令已处理（从持久化回执恢复）',
      ...(snap ? { snapshot: snap } : {}),
      firstApplied: false,
      duplicate: true
    }
  }
}
