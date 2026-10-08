import { app } from 'electron'
import { join } from 'node:path'
import type { ChatMessage } from '../../runtime/model/types'
import type { SessionStore } from '../../runtime/sessions/SessionStore'
import { buildConversationContext } from '../../runtime/sessions'
import { getSessionActiveMessages } from '../../runtime/sessions/tree'
import { extractTextFromContent } from '../../runtime/model/types'
import { MemoryExtractor, projectExtractionMessages } from '../../runtime/memory/extraction/MemoryExtractor'
import { createExtractChatFn } from './MemoryModelChat'
import { organizeMemoryAfterExtract } from './MemoryMaintenanceHost'
export { createExtractChatFn } from './MemoryModelChat'
import { MEMORY_TOOL_NAMES } from '../../runtime/memory/memoryTools'
import { computeWorkspaceHash } from '../../runtime/memory/MemoryPaths'
import {
  MEMORY_EXTRACT_INTERVAL_TURNS, MEMORY_EXTRACT_WINDOW_SIZE, MEMORY_EXTRACT_MIN_NEW_USER_CHARS,
  MEMORY_EXTRACT_EXISTING_LIST_MAX,
  MEMORY_EXTRACT_BACKFILL_DELAY_MS, MEMORY_EXTRACT_BACKFILL_MAX_AGE_DAYS, MEMORY_EXTRACT_BACKFILL_MAX_SESSIONS
} from '../../runtime/memory/memoryConfig'
import { loadNovaSettings } from '../../runtime/settings/novaSettings'
import { getMemoryService, getMemoryCandidateProcessor, getMemoryRepository } from './MemoryServiceHost'
import { drainAndPersistSync, drainAndSchedulePersist } from './MemoryConsolidationHost'
import { isMemoryExcludedSession, isMemoryExcludedMode } from './MemorySessionExclusion'
import { getSessionStore } from './SessionStoreHost'
import { MemoryExtractScheduler, type MemoryExtractCursor, type MemoryExtractOutcome } from './MemoryExtractScheduler'
import { isSessionTurnInProgress } from '../agent/state/AgentExecutionStateHost'
import { isMemoryExcludedSessionState } from '../../runtime/memory/MemorySessionExclusion'

const userTurnsSinceExtract = new Map<string, number>()
let scheduler: MemoryExtractScheduler | null = null
let backfillTimer: ReturnType<typeof setTimeout> | undefined

export function isMemoryExtractEnabled(): boolean { return loadNovaSettings().memoryEnabled }
function autoExtractEnabled(): boolean {
  const settings = loadNovaSettings()
  return settings.memoryEnabled && settings.memoryAutoExtractEnabled
}

function getScheduler(sessionStore: SessionStore = getSessionStore()): MemoryExtractScheduler {
  if (!scheduler) scheduler = new MemoryExtractScheduler({
    memoryRoot: join(app.getPath('userData'), 'memory'), enabled: autoExtractEnabled,
    exists: sessionId => !!sessionStore.loadMetadata(sessionId),
    execute: (sessionId, workspaceRoot, cursor, signal) => executeExtract(sessionId, workspaceRoot, sessionStore, cursor, signal)
  })
  return scheduler
}

export function initializeMemoryExtractHost(): void {
  if (backfillTimer) clearTimeout(backfillTimer)
  backfillTimer = setTimeout(() => {
    if (!autoExtractEnabled()) return
    try {
      const store = getSessionStore(), queue = getScheduler(store)
      const cutoff = Date.now() - MEMORY_EXTRACT_BACKFILL_MAX_AGE_DAYS * 86_400_000
      const sessions = store.list().filter(session => session.updatedAt >= cutoff && !!session.workspaceRoot)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .filter(session => {
          const data = store.load(session.id)
          return data?.kind === 'primary' && !data.memoryOptOut && !isMemoryExcludedMode(data.mode)
            && getSessionActiveMessages(data).at(-1)?.id !== queue.getCursor(session.id)?.lastMessageId
        }).slice(0, MEMORY_EXTRACT_BACKFILL_MAX_SESSIONS)
      for (const session of sessions) queue.enqueue(session.id, session.workspaceRoot!, 0)
    } catch { console.error('[MemoryExtract] startup queue unavailable') }
  }, MEMORY_EXTRACT_BACKFILL_DELAY_MS)
  backfillTimer.unref?.()
}

export function resetExtractTurnCountersForTests(): void {
  userTurnsSinceExtract.clear()
  scheduler?.dispose(); scheduler = null
  if (backfillTimer) clearTimeout(backfillTimer)
  backfillTimer = undefined
}

export function shutdownMemoryExtractHost(): void {
  scheduler?.dispose()
  if (backfillTimer) clearTimeout(backfillTimer)
}

export function onMemoryExtractTurnStarted(sessionId: string): void { scheduler?.onTurnStarted(sessionId) }
export function skipMemoryExtractionThroughCurrentTail(sessionId: string, store: SessionStore = getSessionStore()): void {
  const session = store.load(sessionId)
  if (!session) return
  userTurnsSinceExtract.delete(sessionId)
  getScheduler(store).advanceThrough(sessionId, getSessionActiveMessages(session).at(-1)?.id ?? null)
}
/**
 * turn 收尾与离开会话时的跳过不能抛出：失败只会让光标停留，提炼执行前仍会复查 memoryOptOut。
 * 重新开启记忆的 IPC 仍直接调用会抛出的版本，避免退出期间的消息在光标未推进时被补提炼。
 */
function skipOptedOutTail(sessionId: string): void {
  try { skipMemoryExtractionThroughCurrentTail(sessionId) } catch { console.error('[MemoryExtract] opt-out cursor update unavailable') }
}
export function clearMemoryExtractSession(sessionId: string): void {
  userTurnsSinceExtract.delete(sessionId)
  try { getScheduler().removeSession(sessionId) } catch { console.error('[MemoryExtract] cursor cleanup unavailable') }
}

export function onUserTurnCompleteForExtract(sessionId: string, workspaceRoot: string): void {
  if (getSessionStore().loadMetadata(sessionId)?.memoryOptOut) { skipOptedOutTail(sessionId); return }
  if (!isMemoryExtractEnabled() || isMemoryExcludedSession(sessionId)) return
  const next = (userTurnsSinceExtract.get(sessionId) ?? 0) + 1
  if (next < MEMORY_EXTRACT_INTERVAL_TURNS) { userTurnsSinceExtract.set(sessionId, next); return }
  userTurnsSinceExtract.set(sessionId, 0)
  drainAndSchedulePersist(sessionId, workspaceRoot)
  if (autoExtractEnabled()) scheduleMemoryExtract(sessionId, workspaceRoot)
}

export function extractOnSessionLeave(sessionId: string, workspaceRoot: string): void {
  userTurnsSinceExtract.delete(sessionId)
  if (getSessionStore().loadMetadata(sessionId)?.memoryOptOut) { skipOptedOutTail(sessionId); return }
  if (!isMemoryExtractEnabled() || isMemoryExcludedSession(sessionId)) return
  drainAndPersistSync(sessionId, workspaceRoot)
  if (autoExtractEnabled()) scheduleMemoryExtract(sessionId, workspaceRoot, undefined, { sync: true })
}

export function scheduleMemoryExtract(sessionId: string, workspaceRoot: string, sessionStore?: SessionStore, options: { sync?: boolean } = {}): void {
  if (!autoExtractEnabled()) return
  try { getScheduler(sessionStore).enqueue(sessionId, workspaceRoot, options.sync ? 0 : undefined) }
  catch { console.error('[MemoryExtract] queue unavailable') }
}

export async function runMemoryExtract(sessionId: string, workspaceRoot: string, sessionStore: SessionStore): Promise<void> {
  if (!autoExtractEnabled()) return
  await getScheduler(sessionStore).runNow(sessionId, workspaceRoot)
}

async function executeExtract(sessionId: string, workspaceRoot: string, sessionStore: SessionStore, cursor: MemoryExtractCursor | undefined, signal: AbortSignal): Promise<MemoryExtractOutcome> {
  if (isSessionTurnInProgress(sessionId)) return { lastMessageId: cursor?.lastMessageId ?? null, deferred: true }
  const session = sessionStore.load(sessionId)
  if (session?.memoryOptOut) { skipMemoryExtractionThroughCurrentTail(sessionId, sessionStore); return { lastMessageId: cursor?.lastMessageId ?? null, excluded: true } }
  if (!autoExtractEnabled() || !session || isMemoryExcludedSessionState(session)) return { lastMessageId: cursor?.lastMessageId ?? null, excluded: true }
  const active = getSessionActiveMessages(session)
  const lastMessageId = active.at(-1)?.id ?? null
  const cursorIndex = cursor?.lastMessageId ? active.findIndex(message => message.id === cursor.lastMessageId) : -1
  const range = active.slice(cursorIndex + 1)
  if (!range.length) return { lastMessageId }
  // The selected range forms its own projection root without changing durable messages.
  const messages = range.map((message, index) => index === 0 ? { ...message, parentId: null } : message)
  const recentMessages = excludeMemoryToolMessages(projectExtractionMessages(buildConversationContext({ ...session, messages, currentLeafId: lastMessageId }, session.mode))).slice(-MEMORY_EXTRACT_WINDOW_SIZE)
  const userChars = recentMessages.filter(message => message.role === 'user').reduce((sum, message) => sum + extractTextFromContent(message.content).replace(/\s/g, '').length, 0)
  if (userChars < MEMORY_EXTRACT_MIN_NEW_USER_CHARS) return { lastMessageId }
  try {
    const service = getMemoryService(), scopeId = service.registerWorkspace(workspaceRoot)
    const repository = getMemoryRepository()
    const existingEntries = [
      ...repository.listByScope({ scopeKind: 'project', scopeId }, { status: 'active', limit: MEMORY_EXTRACT_EXISTING_LIST_MAX }),
      ...repository.listByScope({ scopeKind: 'global', scopeId: 'user' }, { status: 'active', limit: MEMORY_EXTRACT_EXISTING_LIST_MAX })
    ].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, MEMORY_EXTRACT_EXISTING_LIST_MAX).map(entry => `[${entry.kind}] ${entry.memoryKey ?? ''} — ${entry.content}`)
    const candidates = await new MemoryExtractor({ chat: createExtractChatFn() }).extract({ sessionId, recentMessages, observations: [], existingEntries, abortSignal: signal })
    // Deletion, opt-out and switch changes during the model call must prevent writes.
    const current = sessionStore.loadMetadata(sessionId)
    if (current?.memoryOptOut) { skipMemoryExtractionThroughCurrentTail(sessionId, sessionStore); return { lastMessageId, excluded: true } }
    if (signal.aborted || !autoExtractEnabled() || !current || current.kind !== 'primary' || current.memoryOptOut || isMemoryExcludedMode(current.mode)) return { lastMessageId: cursor?.lastMessageId ?? null, excluded: true }
    if (candidates === null) return { lastMessageId, failed: true }
    if (candidates.length) {
      const counts = getMemoryCandidateProcessor().process({ sessionId, projectScopeId: computeWorkspaceHash(workspaceRoot), workspaceRoot, candidates, via: 'extract' })
      console.log(`[MemoryExtract] ${JSON.stringify(counts)}`)
      if (counts.failed > 0) return { lastMessageId, failed: true }
    }
    await organizeMemoryAfterExtract(scopeId)
    return { lastMessageId }
  } catch { return { lastMessageId, failed: true } }
}

function excludeMemoryToolMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const excluded = new Set<string>()
  const projected = messages.map(message => {
    if (message.role !== 'assistant' || !message.toolCalls?.length) return message
    const toolCalls = message.toolCalls.filter(call => { if (!MEMORY_TOOL_NAMES.has(call.name)) return true; excluded.add(call.id); return false })
    return toolCalls.length === message.toolCalls.length ? message : { ...message, toolCalls: toolCalls.length ? toolCalls : undefined }
  })
  return projected.filter(message => message.role !== 'tool' || !message.toolCallId || !excluded.has(message.toolCallId))
}
