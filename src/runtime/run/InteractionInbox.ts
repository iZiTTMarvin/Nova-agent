/**
 * InteractionInbox — 持久化挂起交互
 *
 * 每个 pending interaction 含稳定 interactionId、run/session/message 归属、类型与状态。
 * 状态写入 RunStore（经 RunCoordinator），不只在内存 Map。
 *
 * 禁止：给所有问题一律加自动 timeout。等待用户不是故障。
 */
import { randomUUID } from 'crypto'
import type { RunCoordinator } from './RunCoordinator'
import type {
  InteractionAnswerCommand,
  InteractionAnswerResult,
  InteractionStatus,
  InteractionType,
  PendingInteraction,
  RunSnapshot
} from './types'

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
  /** commandId → 已处理结果（进程内幂等） */
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
   * Renderer 在 ACK 前只应置 submitting，不提前删 pending。
   */
  answer(cmd: InteractionAnswerCommand): InteractionAnswerResult {
    const cached = this.answeredCommands.get(cmd.commandId)
    if (cached) {
      return cached
    }

    const found = this.coordinator.findInteraction(cmd.interactionId)
    if (!found) {
      const result: InteractionAnswerResult = {
        ok: false,
        code: 'not_found',
        message: `交互 ${cmd.interactionId} 不存在`
      }
      this.answeredCommands.set(cmd.commandId, result)
      return result
    }

    const snap = this.coordinator.getSnapshot(found.runId)
    if (!snap) {
      const result: InteractionAnswerResult = {
        ok: false,
        code: 'not_found',
        message: `run ${found.runId} 不存在`
      }
      this.answeredCommands.set(cmd.commandId, result)
      return result
    }

    if (found.status === 'answered' || found.status === 'dismissed' || found.status === 'cancelled') {
      const result: InteractionAnswerResult = {
        ok: false,
        code: 'already_answered',
        message: `交互已处理（status=${found.status}）`,
        snapshot: snap
      }
      this.answeredCommands.set(cmd.commandId, result)
      return result
    }

    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled') {
      const result: InteractionAnswerResult = {
        ok: false,
        code: 'run_ended',
        message: `run 已结束（status=${snap.status}）`,
        snapshot: snap
      }
      this.answeredCommands.set(cmd.commandId, result)
      return result
    }

    if (found.version !== cmd.expectedVersion) {
      const result: InteractionAnswerResult = {
        ok: false,
        code: 'version_mismatch',
        message: `版本不匹配：期望 ${cmd.expectedVersion}，实际 ${found.version}`,
        snapshot: snap
      }
      // version mismatch 不缓存为成功，允许客户端用新 version 重试；但同一 commandId 仍记一次
      this.answeredCommands.set(cmd.commandId, result)
      return result
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
      const result: InteractionAnswerResult = {
        ok: false,
        code: 'not_found',
        message: '更新交互失败'
      }
      this.answeredCommands.set(cmd.commandId, result)
      return result
    }

    // 若无其他 pending，尝试回到 running
    this.coordinator.resumeFromWaitingIfClear(found.runId)

    const nextSnap = this.coordinator.getSnapshot(found.runId)!
    const result: InteractionAnswerResult = {
      ok: true,
      interaction: updated,
      snapshot: nextSnap
    }
    this.answeredCommands.set(cmd.commandId, result)
    return result
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
}
