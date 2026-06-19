/**
 * 上下文快照装配逻辑（T2.6 / T2.7 共享实现）
 *
 * agentHandler 与单测共用本模块，避免测试镜像与生产闭包漂移。
 * 约束：只读写 context-snapshot.json，不修改 session.messages。
 */
import { AgentLoop } from '../agent/AgentLoop'
import { buildConversationContext } from '../agent/contextBuilder'
import type { CompactionMeta } from '../agent/types'
import type { ChatMessage } from '../model/types'
import type { SessionStore } from './SessionStore'
import {
  CONTEXT_SNAPSHOT_VERSION,
  type ContextSnapshot,
  type SessionData
} from './types'

/**
 * 从压缩后的运行时上下文构建快照对象（不落盘）。
 * @param session 压缩当刻的会话数据，用于取 lastMessageId 锚点
 */
export function buildSnapshotFromCompaction(
  session: SessionData,
  compactedContext: ChatMessage[],
  meta: CompactionMeta
): ContextSnapshot {
  return {
    version: CONTEXT_SNAPSHOT_VERSION,
    summary: meta.summary,
    recentMessages: compactedContext.filter(m => m.role !== 'system'),
    lastMessageId: session.messages.at(-1)?.id ?? '',
    compactionLevel: meta.compactionLevel,
    updatedAt: Date.now()
  }
}

/**
 * 压缩完成时持久化快照。找不到会话时返回 false（调用方负责打日志）。
 */
export function persistCompactionSnapshot(
  store: SessionStore,
  sessionId: string,
  compactedContext: ChatMessage[],
  meta: CompactionMeta
): boolean {
  const session = store.load(sessionId)
  if (!session) return false
  store.saveContextSnapshot(
    sessionId,
    buildSnapshotFromCompaction(session, compactedContext, meta)
  )
  return true
}

/**
 * 快照优先恢复运行时上下文；无快照或锚点失效时全量 injectHistory。
 * @param agentLoop 已完成 setToolRegistry 的实例
 * @param session handler 入口加载的会话（新用户消息尚未 append）
 * @param snapshot loadContextSnapshot 的结果，可传 null
 */
export function restoreOrInjectHistory(
  agentLoop: AgentLoop,
  session: SessionData,
  snapshot: ContextSnapshot | null
): void {
  const anchorIdx = snapshot
    ? session.messages.findIndex(m => m.id === snapshot.lastMessageId)
    : -1

  if (snapshot && anchorIdx >= 0) {
    const delta = session.messages.slice(anchorIdx + 1)
    const deltaContext = buildConversationContext({ ...session, messages: delta }, session.mode)
    const recent = [...snapshot.recentMessages, ...deltaContext]
    agentLoop.restoreCompactedContext(snapshot.summary, recent, snapshot.compactionLevel)
  } else {
    agentLoop.injectHistory(buildConversationContext(session, session.mode))
  }
}
