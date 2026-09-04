/**
 * history_read — 只读被折叠区间的档案 transcript，形状对齐 archive_read。
 */
import type { ToolExecutor, ToolContext, ToolResult } from '../types'
import type { ChatMessage, MessageOrigin } from '../../model/types'
import type { CompactionLedger, LedgerEntry } from '../../sessions/types'
import {
  buildConversationContext,
  renderMessagesAsTranscript
} from '../../agent/context/contextBuilder'
import {
  createRequestProjectionArchiveCache,
  projectRequestMessages
} from '../../agent/core/projectRequestMessages'
import { ARCHIVE_READ_MAX_RESPONSE_CHARS } from '../archiveRead'

export const HISTORY_READ_MAX_RESPONSE_CHARS = ARCHIVE_READ_MAX_RESPONSE_CHARS
export const HISTORY_READ_DEFAULT_LIMIT = 4000
export const HISTORY_READ_MAX_LIMIT = 6000

const TOOL_NAME = 'history_read'
const TOOL_DESCRIPTION =
  '读取已被压缩折叠的对话原文。按 checkpoint id（如 c3）inspect / search / read；缺省覆盖全部被折叠区间。大工具结果为占位符时再用 archive_read 读全文。'

function sameOrigin(left: MessageOrigin | undefined, right: MessageOrigin): boolean {
  return Boolean(
    left
    && left.messageId === right.messageId
    && left.step === right.step
  )
}

function lastIndexWithOrigin(messages: ChatMessage[], origin: MessageOrigin): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (sameOrigin(messages[i]?.origin, origin)) return i
  }
  return -1
}

function sliceByShadows(
  messages: ChatMessage[],
  from: MessageOrigin,
  to: MessageOrigin
): ChatMessage[] {
  const start = messages.findIndex(message => sameOrigin(message.origin, from))
  // 同一工具组的 assistant + tool* 共用 origin；闭区间必须包到该组最后一条
  const end = lastIndexWithOrigin(messages, to)
  if (start < 0 || end < 0 || end < start) return []
  return messages.slice(start, end + 1)
}

function resolveEntries(
  ledger: CompactionLedger,
  checkpoint: string | undefined
): { ok: true; entries: LedgerEntry[] } | { ok: false; checkpoint: string } {
  if (!checkpoint) return { ok: true, entries: ledger.entries }
  const entry = ledger.entries.find(item => item.id === checkpoint)
  if (!entry) return { ok: false, checkpoint }
  return { ok: true, entries: [entry] }
}

function shrinkLimitToFit(
  buildResponse: (limit: number) => string,
  initialLimit: number
): { limit: number; serialized: string } {
  let limit = initialLimit
  let serialized = buildResponse(limit)
  while (serialized.length > HISTORY_READ_MAX_RESPONSE_CHARS && limit > 1) {
    limit = Math.max(1, Math.floor(limit / 2))
    serialized = buildResponse(limit)
  }
  return { limit, serialized }
}

async function projectFoldedMessages(
  messages: ChatMessage[],
  context: ToolContext
): Promise<ChatMessage[]> {
  if (!context.artifactStore || !context.sessionId) return messages
  const artifactStore = context.artifactStore
  const sessionId = context.sessionId
  const result = await projectRequestMessages({
    messages,
    policy: { enabled: true },
    archiveCache: createRequestProjectionArchiveCache(),
    archive: async candidate => {
      try {
        const meta = await artifactStore.writeContentAddressed(sessionId, candidate.body, {
          toolName: candidate.toolName
        })
        return { artifactId: meta.id }
      } catch {
        return null
      }
    }
  })
  return result.messages
}

async function loadFoldedTranscript(
  context: ToolContext,
  entries: LedgerEntry[]
): Promise<{ ok: true; transcript: string; messages: ChatMessage[] } | { ok: false; error: string }> {
  const sessionStore = context.sessionStore
  const sessionId = context.sessionId
  if (!sessionStore || !sessionId) {
    return { ok: false, error: 'history_read 需要 sessionStore 与 sessionId' }
  }
  const session = sessionStore.load(sessionId)
  if (!session) {
    return { ok: false, error: '会话不存在' }
  }
  const archive = buildConversationContext(session, session.mode)
  const folded = entries.flatMap(entry =>
    sliceByShadows(archive, entry.shadows.from, entry.shadows.to)
  )
  const projected = await projectFoldedMessages(folded, context)
  return {
    ok: true,
    transcript: renderMessagesAsTranscript(projected),
    messages: projected
  }
}

function jsonResult(payload: unknown): ToolResult {
  return { success: true, output: JSON.stringify(payload) }
}

function parseHistoryReadOperation(
  value: unknown
): 'inspect' | 'search' | 'read' | null {
  if (value === undefined || value === '') return 'inspect'
  if (value === 'inspect' || value === 'search' || value === 'read') return value
  return null
}

function typedError(code: string, extra: Record<string, unknown> = {}): ToolResult {
  return {
    success: false,
    output: JSON.stringify({ ok: false, code, ...extra }),
    error: code
  }
}

const historyReadTool: ToolExecutor = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['inspect', 'search', 'read'],
        default: 'inspect',
        description: 'inspect=查看被折叠区间结构，search=字面搜索，read=分页读回 transcript'
      },
      checkpoint: {
        type: 'string',
        description: '账本条目 id，如 c3；缺省覆盖全部被折叠区间'
      },
      query: {
        type: 'string',
        description: 'search 操作的字面关键词，不区分大小写'
      },
      offset: {
        type: 'number',
        default: 1,
        description: 'read 操作的起始行号（1-based）'
      },
      limit: {
        type: 'number',
        description: 'read 操作的最大行数'
      }
    },
    additionalProperties: false
  },
  executionMode: 'parallel',
  isConcurrencySafe: () => true,

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const sessionId = context.sessionId
    const ledger = sessionId ? context.sessionStore?.loadContextSnapshot(sessionId) : null
    if (!ledger || ledger.entries.length === 0) {
      return typedError('empty_ledger')
    }

    const checkpoint = typeof args.checkpoint === 'string' ? args.checkpoint.trim() : ''
    const resolved = resolveEntries(ledger, checkpoint || undefined)
    if (!resolved.ok) {
      return typedError('unknown_checkpoint', { checkpoint: resolved.checkpoint })
    }

    const operation = parseHistoryReadOperation(args.operation)
    if (!operation) {
      return typedError('unknown_operation', { operation: args.operation })
    }

    if (operation === 'inspect') {
      return jsonResult({
        ok: true,
        operation: 'inspect',
        checkpoints: resolved.entries.map(entry => ({
          id: entry.id,
          from: entry.shadows.from,
          to: entry.shadows.to,
          stub: entry.stub,
          touchedFiles: entry.touchedFiles
        })),
        hint: 'operation: "read" with checkpoint for transcript; "search" with query to locate lines'
      })
    }

    const loaded = await loadFoldedTranscript(context, resolved.entries)
    if (!loaded.ok) {
      return { success: false, output: '', error: loaded.error }
    }

    const lines = loaded.transcript.length > 0 ? loaded.transcript.split('\n') : []

    if (operation === 'search') {
      const query = typeof args.query === 'string' ? args.query : ''
      if (!query) {
        return { success: false, output: '', error: 'search 操作需要 query 参数' }
      }
      const needle = query.toLowerCase()
      const matches: Array<{ line: number; content: string }> = []
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) {
          matches.push({ line: i + 1, content: lines[i]! })
        }
      }
      const build = (maxMatches: number) => JSON.stringify({
        ok: true,
        operation: 'search',
        query,
        scanned: lines.length,
        matched: matches.length,
        truncated: maxMatches < matches.length,
        matches: matches.slice(0, maxMatches)
      })
      if (matches.length === 0) {
        const ids = resolved.entries.map(entry => entry.id).join(', ')
        return jsonResult({
          ok: true,
          operation: 'search',
          query,
          scanned: lines.length,
          matched: 0,
          truncated: false,
          matches: [],
          hint: `未命中。可对 checkpoint 直接 read，例如 history_read({ operation: "read", checkpoint: "${resolved.entries[0]?.id ?? 'c1'}" })。当前区间: ${ids}`
        })
      }
      const serialized = build(matches.length)
      if (serialized.length <= HISTORY_READ_MAX_RESPONSE_CHARS) {
        return { success: true, output: serialized }
      }
      const { serialized: shrunk } = shrinkLimitToFit(build, matches.length)
      return { success: true, output: shrunk }
    }

    if (operation === 'read') {
      const offset = typeof args.offset === 'number' ? Math.max(1, args.offset) : 1
      const requestedLimit = typeof args.limit === 'number' ? args.limit : HISTORY_READ_DEFAULT_LIMIT
      const effectiveLimit = Math.min(requestedLimit, HISTORY_READ_MAX_LIMIT)
      const buildRead = (limit: number) => {
        const start = Math.min(offset - 1, lines.length)
        const end = Math.min(start + limit, lines.length)
        return JSON.stringify({
          ok: true,
          operation: 'read',
          lines: lines.slice(start, end),
          offset,
          limit,
          nextOffset: end < lines.length ? end + 1 : null,
          hasMore: end < lines.length,
          totalLines: lines.length
        })
      }
      const { serialized } = shrinkLimitToFit(buildRead, effectiveLimit)
      return { success: true, output: serialized }
    }

    return typedError('unknown_operation', { operation })
  }
}

export { historyReadTool }
export default historyReadTool
