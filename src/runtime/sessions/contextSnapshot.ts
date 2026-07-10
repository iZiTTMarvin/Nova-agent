/**
 * 上下文快照装配逻辑（T2.6 / T2.7 共享实现）
 *
 * agentHandler 与单测共用本模块，避免测试镜像与生产闭包漂移。
 * 约束：只读写 context-snapshot.json，不修改 session.messages。
 */
import { AgentLoop } from '../agent/AgentLoop'
import { buildConversationContext, resolveImageUrlsInMessages } from '../agent/context/contextBuilder'
import type { CompactionMeta } from '../agent/types'
import type { CacheProfile } from '../model/cacheProfile'
import type { ChatMessage } from '../model/types'
import type { SessionStore } from './SessionStore'
import {
  CONTEXT_SNAPSHOT_VERSION,
  type ContextSnapshot,
  type SessionData
} from './types'
import { getSessionActiveMessages } from './tree'

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
    lastMessageId: getSessionActiveMessages(session).at(-1)?.id ?? '',
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

/** restoreOrInjectHistory 的可选恢复参数 */
export interface RestoreHistoryOptions {
  resolveImageUrl?: (url: string) => string
  /** 来自当前 active CacheProfile；决定是否按 blocks 拆子轮恢复 reasoning */
  reasoningReplay?: CacheProfile['reasoningReplay']
}

/**
 * 快照优先恢复运行时上下文；无快照或锚点失效时全量 injectHistory。
 * @param agentLoop 已完成 setToolRegistry 的实例
 * @param session handler 入口加载的会话（新用户消息尚未 append）
 * @param snapshot loadContextSnapshot 的结果，可传 null
 * @param resolveImageUrlOrOpts 可选的图片 URL 转换器，或含 reasoningReplay 的选项对象。
 *   历史消息与压缩快照里存的都是内部协议 URL，模型 API 不认识，必须转换后才能发给模型。
 *   不传则原样透传（单测路径）。
 */
export function restoreOrInjectHistory(
  agentLoop: AgentLoop,
  session: SessionData,
  snapshot: ContextSnapshot | null,
  resolveImageUrlOrOpts?: ((url: string) => string) | RestoreHistoryOptions
): void {
  const opts: RestoreHistoryOptions =
    typeof resolveImageUrlOrOpts === 'function'
      ? { resolveImageUrl: resolveImageUrlOrOpts }
      : resolveImageUrlOrOpts ?? {}
  const { resolveImageUrl, reasoningReplay } = opts

  const buildOpts = {
    ...(resolveImageUrl ? { resolveImageUrl } : {}),
    ...(reasoningReplay ? { reasoningReplay } : {})
  }

  const activeMessages = getSessionActiveMessages(session)
  const anchorIdx = snapshot
    ? activeMessages.findIndex(m => m.id === snapshot.lastMessageId)
    : -1

  if (snapshot && anchorIdx >= 0) {
    const delta = activeMessages.slice(anchorIdx + 1)
    const deltaContext = buildConversationContext(
      { ...session, messages: delta },
      session.mode,
      buildOpts
    )
    // 快照里的 recentMessages 持久化时同样存了 nova-image:// URL，需一并转换；
    // recent 中已有的 reasoningContent 原样保留，供继续工具链
    const recentResolved = resolveImageUrl
      ? resolveImageUrlsInMessages(snapshot.recentMessages, resolveImageUrl)
      : snapshot.recentMessages
    const recent = [...recentResolved, ...deltaContext]
    agentLoop.restoreCompactedContext(snapshot.summary, recent, snapshot.compactionLevel)
  } else {
    agentLoop.injectHistory(buildConversationContext(session, session.mode, buildOpts))
  }
}
