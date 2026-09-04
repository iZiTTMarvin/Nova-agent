/**
 * 压缩账本装配：只读写 context-snapshot.json，不修改 session.messages。
 * 恢复 = 纯函数(档案, 账本)，不复制消息正文。
 */
import { AgentLoop } from '../agent/AgentLoop'
import {
  buildConversationContext,
  resolveImageUrlsInMessages
} from './conversationContext'
import { rebuildWithCompression } from '../agent/compaction/compaction'
import type { ChatMessage } from '../model/types'
import type { CacheProfile } from '../model/cacheProfile'
import type { SessionStore } from './SessionStore'
import {
  CONTEXT_SNAPSHOT_VERSION,
  type CompactionLedger,
  type SessionData
} from './types'
import type { MessageOrigin } from '../model/types'
import { getSessionActiveMessages } from './tree'

export type LedgerRestoreKind = 'restored' | 'empty-tail' | 'invalid'

export interface RestoreFromLedgerResult {
  kind: LedgerRestoreKind
  messages: ChatMessage[]
}

/** restoreOrInjectHistory 的可选恢复参数 */
export interface RestoreHistoryOptions {
  resolveImageUrl?: (url: string) => string
  /** 来自当前 active CacheProfile；决定是否按 blocks 拆子轮恢复 reasoning */
  reasoningReplay?: CacheProfile['reasoningReplay']
  /** 当前档案 ID；跨档案 reasoning 门控 */
  currentProviderId?: string
  /** 坐标失效（切分支）时清空账本 */
  sessionStore?: SessionStore
}

function originMessageId(origin: MessageOrigin | null | undefined): string | null {
  const id = origin?.messageId
  return id ? id : null
}

function originKey(origin: MessageOrigin | null | undefined): string | null {
  const id = originMessageId(origin)
  return id && origin ? `${id}\0${origin.step}` : null
}

/**
 * tailFrom 尚未落盘时按空尾部恢复；已提交条目与状态坐标必须仍在激活路径。
 */
export function classifyLedgerRestore(
  session: SessionData,
  ledger: CompactionLedger
): Exclude<LedgerRestoreKind, never> {
  const activeIds = new Set(getSessionActiveMessages(session).map(m => m.id))
  const allIds = new Set(session.messages.map(m => m.id))
  const activeOriginPositions = new Map<string, { first: number; last: number }>()
  for (const [index, message] of buildConversationContext(session, session.mode).entries()) {
    const key = originKey(message.origin)
    if (!key) continue
    const current = activeOriginPositions.get(key)
    activeOriginPositions.set(key, {
      first: current?.first ?? index,
      last: index
    })
  }

  const locate = (
    origin: MessageOrigin | null | undefined
  ): 'ok' | 'missing' | 'off-path' | 'invalid-step' | 'skip' => {
    const id = originMessageId(origin)
    if (!id) return 'skip'
    if (!allIds.has(id)) return 'missing'
    if (!activeIds.has(id)) return 'off-path'
    const key = originKey(origin)
    return key && activeOriginPositions.has(key) ? 'ok' : 'invalid-step'
  }

  for (const entry of ledger.entries) {
    if (locate(entry.shadows.from) !== 'ok') return 'invalid'
    if (locate(entry.shadows.to) !== 'ok') return 'invalid'
    const from = activeOriginPositions.get(originKey(entry.shadows.from)!)!
    const to = activeOriginPositions.get(originKey(entry.shadows.to)!)!
    if (from.first > to.last) return 'invalid'
  }
  if (ledger.state && locate(ledger.state.coversThrough) !== 'ok') return 'invalid'

  const tailStatus = locate(ledger.tailFrom)
  if (tailStatus === 'off-path' || tailStatus === 'invalid-step') return 'invalid'
  if (tailStatus === 'missing') return 'empty-tail'
  return 'restored'
}

export function restoreFromLedger(
  session: SessionData,
  ledger: CompactionLedger,
  frozenSystemPrompt: string,
  buildOpts: {
    resolveImageUrl?: (url: string) => string
    reasoningReplay?: CacheProfile['reasoningReplay']
    currentProviderId?: string
  } = {}
): RestoreFromLedgerResult {
  const kind = classifyLedgerRestore(session, ledger)
  if (kind === 'invalid') {
    return { kind: 'invalid', messages: [] }
  }

  let tail: ChatMessage[] = []
  if (kind !== 'empty-tail' && ledger.tailFrom) {
    tail = buildConversationContext(session, session.mode, {
      ...buildOpts,
      from: ledger.tailFrom
    })
  }

  if (buildOpts.resolveImageUrl && tail.length > 0) {
    tail = resolveImageUrlsInMessages(tail, buildOpts.resolveImageUrl)
  }

  return {
    kind,
    messages: rebuildWithCompression(frozenSystemPrompt, ledger, tail)
  }
}

/**
 * 压缩完成时持久化账本。找不到会话时返回 false（调用方负责打日志）。
 */
export function persistCompactionSnapshot(
  store: SessionStore,
  sessionId: string,
  ledger: CompactionLedger
): boolean {
  const session = store.load(sessionId)
  if (!session) return false
  store.saveContextSnapshot(sessionId, ledger)
  return true
}

/**
 * 账本优先恢复运行时上下文；无账本或坐标失效时全量 injectHistory。
 * tailFrom.messageId 尚未落盘时恢复为空尾部，不抛错。
 */
export function restoreOrInjectHistory(
  agentLoop: AgentLoop,
  session: SessionData,
  ledger: CompactionLedger | null,
  resolveImageUrlOrOpts?: ((url: string) => string) | RestoreHistoryOptions
): void {
  const opts: RestoreHistoryOptions =
    typeof resolveImageUrlOrOpts === 'function'
      ? { resolveImageUrl: resolveImageUrlOrOpts }
      : resolveImageUrlOrOpts ?? {}
  const { resolveImageUrl, reasoningReplay, currentProviderId, sessionStore } = opts

  const buildOpts = {
    ...(resolveImageUrl ? { resolveImageUrl } : {}),
    ...(reasoningReplay ? { reasoningReplay } : {}),
    ...(currentProviderId ? { currentProviderId } : {})
  }

  if (!ledger || ledger.version !== CONTEXT_SNAPSHOT_VERSION) {
    agentLoop.injectHistory(buildConversationContext(session, session.mode, buildOpts))
    return
  }

  const restored = restoreFromLedger(
    session,
    ledger,
    agentLoop.getFrozenSystemPrompt(),
    buildOpts
  )

  if (restored.kind === 'invalid') {
    sessionStore?.clearContextSnapshot(session.id)
    agentLoop.injectHistory(buildConversationContext(session, session.mode, buildOpts))
    return
  }

  agentLoop.restoreCompactedContext(ledger, restored.messages.slice(1))
}
