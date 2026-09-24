import type { RunCoordinator } from '../run/RunCoordinator'
import type { SessionStore } from './SessionStore'
import { MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE } from './messageProjection'
import { isTerminalRunStatus, type RunSnapshot } from '../../shared/run/types'

/** 结算接口的输入类型（由 sessions 端口层定义，不依赖 subagents）。 */
export interface InterruptedToolSettlementInput {
  readonly sessionId: string
  readonly parentRunId: string
  readonly parentMessageId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly args: unknown
}

/** 结算接口的输出类型。 */
export interface InterruptedToolSettlement {
  readonly status: 'success' | 'error'
  readonly result: string
}

/**
 * 结算一个 running tool block。
 * 返回 null 表示该 block 不是子代理工具调用（回落通用文案）。
 * 由调用方注入，不得由 sessions 层直接 import subagents。
 */
export type SettleInterruptedToolBlock = (
  input: InterruptedToolSettlementInput
) => InterruptedToolSettlement | null

/** 将终态 run 遗留草稿交还会话事实源，成功落盘后才清除草稿。 */
export function recoverSessionTurnDrafts(
  sessionId: string,
  store: SessionStore,
  coordinator: RunCoordinator,
  settle?: SettleInterruptedToolBlock
): void {
  for (const snapshot of coordinator.listSnapshotsForSession(sessionId)) {
    const draft = snapshot.turnDraft
    if (!isTerminalRunStatus(snapshot.status) || !draft) continue
    if (draft.messageId !== snapshot.messageId) throw new Error('中断记录身份不一致，原始草稿已保留')
    const userMessageId = draft.userDelivery?.userMessageId ?? resolveFallbackUserMessageId(sessionId, store)
    if (!userMessageId) {
      // 坐标永久缺失时重试无意义：丢弃孤儿草稿解除会话阻断，避免每次打开/发送都报错
      console.warn(
        `[turnDraftRecovery] 草稿缺少用户消息坐标且无法定位锚点，丢弃孤儿草稿 session=${sessionId} run=${snapshot.runId}`
      )
      coordinator.clearTurnDraft(snapshot.runId)
      continue
    }
    const settledBlocks = draft.blocks.map(block => {
      if (block.type !== 'tool' || block.status !== 'running') return block
      if (!settle) return { ...block, status: 'error' as const, result: '工具执行被中断' }
      try {
        const result = settle({
          sessionId,
          parentRunId: snapshot.runId,
          parentMessageId: draft.messageId,
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          args: block.arguments
        })
        if (result === null) return { ...block, status: 'error' as const, result: '工具执行被中断' }
        return { ...block, status: result.status, result: result.result } as typeof block
      } catch (err) {
        console.error(`[turnDraftRecovery] settle 异常 toolCallId=${block.toolCallId}，回落通用文案:`, err)
        return { ...block, status: 'error' as const, result: '工具执行被中断' }
      }
    })
    store.recoverAssistantMessage(sessionId, {
      id: draft.messageId,
      role: 'assistant',
      content: '',
      blocks: settledBlocks,
      messageSchemaVersion: MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE,
      userDelivery: draft.userDelivery,
      timestamp: snapshot.turnStartedAt ?? snapshot.createdAt,
      turnStartedAt: snapshot.turnStartedAt ?? snapshot.createdAt,
      turnEndedAt: draft.updatedAt,
      interrupted: true
    }, userMessageId)
    coordinator.clearTurnDraft(snapshot.runId)
  }
}

/**
 * 旧版本遗留草稿可能缺少投递坐标：中断轮次的 assistant 消息未落盘时，
 * 会话叶子即发起该轮的用户消息，可作为归档锚点。
 */
function resolveFallbackUserMessageId(sessionId: string, store: SessionStore): string | null {
  const session = store.load(sessionId)
  if (!session) return null
  const leaf = session.messages.find(message => message.id === session.currentLeafId)
  return leaf?.role === 'user' ? leaf.id : null
}

/**
 * 启动时批量归档所有终态且存在未移交草稿的 run 快照。
 * 入参为终态且 turnDraft 未 finalized 的 run 快照序列。
 * 归档顺序按会话树"子在父前"（通过 session metadata 的 lineage.depth：
 *   primary=0, subagent=lineage.depth，同一 depth 按 sessionId 稳定排序）。
 * loadMetadata 失败的会话按 depth=0 处理（其恢复大概率失败并被既有 try/catch 隔离）。
 * 单会话失败保留草稿并隔离，不阻断其他会话归档。
 */
export function recoverInterruptedTurnDraftsOnStartup(
  runs: ReadonlyArray<RunSnapshot>,
  store: SessionStore,
  coordinator: RunCoordinator,
  settle?: SettleInterruptedToolBlock
): void {
  const seen = new Set<string>()
  const toRecover: Array<{ sessionId: string; depth: number }> = []
  for (const snapshot of runs) {
    const draft = snapshot.turnDraft
    if (!draft || draft.finalized) continue
    if (seen.has(snapshot.sessionId)) continue
    seen.add(snapshot.sessionId)
    const meta = store.loadMetadata(snapshot.sessionId)
    const depth = meta?.kind === 'subagent' && meta.subagent?.lineage?.depth != null
      ? meta.subagent.lineage.depth
      : 0
    toRecover.push({ sessionId: snapshot.sessionId, depth })
  }
  // 按 depth 降序归档：子在父前
  toRecover.sort((a, b) => b.depth - a.depth || a.sessionId.localeCompare(b.sessionId))
  for (const { sessionId } of toRecover) {
    try {
      recoverSessionTurnDrafts(sessionId, store, coordinator, settle)
    } catch (err) {
      console.error(
        `[turnDraftRecovery] 启动归档失败 session=${sessionId}，已保留草稿:`,
        err
      )
    }
  }
}
