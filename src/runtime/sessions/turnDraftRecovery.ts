import type { RunCoordinator } from '../run/RunCoordinator'
import type { SessionStore } from './SessionStore'
import { MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE } from './messageProjection'
import { isTerminalRunStatus, type RunSnapshot } from '../../shared/run/types'

/** 将终态 run 遗留草稿交还会话事实源，成功落盘后才清除草稿。 */
export function recoverSessionTurnDrafts(sessionId: string, store: SessionStore, coordinator: RunCoordinator): void {
  for (const snapshot of coordinator.listSnapshotsForSession(sessionId)) {
    const draft = snapshot.turnDraft
    if (!isTerminalRunStatus(snapshot.status) || !draft) continue
    if (draft.messageId !== snapshot.messageId) throw new Error('中断记录身份不一致，原始草稿已保留')
    const userMessageId = draft.userDelivery?.userMessageId
    if (!userMessageId) throw new Error('中断记录缺少用户消息坐标，原始草稿已保留')
    store.recoverAssistantMessage(sessionId, {
      id: draft.messageId,
      role: 'assistant',
      content: '',
      blocks: draft.blocks.map(block => block.type === 'tool' && block.status === 'running'
        ? { ...block, status: 'error', result: '工具执行被中断' }
        : block),
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
 * 启动对账后批量归档未打开会话的中断草稿。
 * 按 sessionId 去重调用 recoverSessionTurnDrafts；单会话失败不得阻断启动。
 */
export function recoverInterruptedTurnDraftsOnStartup(
  interrupted: ReadonlyArray<Pick<RunSnapshot, 'sessionId' | 'turnDraft'>>,
  store: SessionStore,
  coordinator: RunCoordinator
): void {
  const seen = new Set<string>()
  for (const snapshot of interrupted) {
    const draft = snapshot.turnDraft
    if (!draft || draft.finalized) continue
    if (seen.has(snapshot.sessionId)) continue
    seen.add(snapshot.sessionId)
    try {
      recoverSessionTurnDrafts(snapshot.sessionId, store, coordinator)
    } catch (err) {
      console.error(
        `[turnDraftRecovery] 启动归档失败 session=${snapshot.sessionId}，已保留草稿:`,
        err
      )
    }
  }
}
