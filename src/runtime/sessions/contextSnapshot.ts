/**
 * 压缩账本装配：只读写 context-snapshot.json，不修改 session.messages。
 * 恢复 = 纯函数(档案, 账本)，不复制消息正文。
 */
import { AgentLoop } from '../agent/AgentLoop'
import {
  buildConversationContext,
  resolveImageUrlsInMessages
} from '../agent/context/contextBuilder'
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

/**
 * 校验账本坐标相对当前档案：
 * - off-path：坐标在档案中但不在激活路径（切分支）
 * - missing-tail：tailFrom 的 messageId 尚未落盘
 * - ok：可以按 tailFrom 切片（缺 id 则空尾部）
 */
export function classifyLedgerRestore(
  session: SessionData,
  ledger: CompactionLedger
): Exclude<LedgerRestoreKind, never> {
  const activeIds = new Set(getSessionActiveMessages(session).map(m => m.id))
  const allIds = new Set(session.messages.map(m => m.id))

  const locate = (origin: MessageOrigin | null | undefined): 'ok' | 'missing' | 'off-path' | 'skip' => {
    const id = originMessageId(origin)
    if (!id) return 'skip'
    if (!allIds.has(id)) return 'missing'
    if (!activeIds.has(id)) return 'off-path'
    return 'ok'
  }

  const tailStatus = locate(ledger.tailFrom)
  if (tailStatus === 'off-path') return 'invalid'
  if (tailStatus === 'missing') return 'empty-tail'

  for (const entry of ledger.entries) {
    if (locate(entry.shadows.from) === 'off-path') return 'invalid'
    if (locate(entry.shadows.to) === 'off-path') return 'invalid'
  }
  if (locate(ledger.state?.coversThrough) === 'off-path') return 'invalid'

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
