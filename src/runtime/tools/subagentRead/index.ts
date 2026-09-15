import {
  extractTextFromSerializableContent,
  getSessionActiveMessages,
  type SessionData,
  type SessionMessage,
  type SessionStore,
  type SubagentSessionData
} from '../../sessions'
import { isSafeArtifactId } from '../../artifacts/artifactRef'
import type { ToolContext, ToolExecutor, ToolResult } from '../types'

const DEFAULT_READ_CHARS = 8_000
const MAX_READ_CHARS = 16_000
const MAX_SEARCH_MATCHES = 24
const SEARCH_CONTEXT_CHARS = 180

type SubagentReadOperation = 'inspect' | 'search' | 'read' | 'artifact_read'

function failure(error: string): ToolResult {
  return { success: false, output: '', error }
}

function jsonResult(payload: unknown): ToolResult {
  return { success: true, output: JSON.stringify(payload) }
}

function renderToolCall(messageId: string, toolCall: NonNullable<SessionMessage['toolCalls']>[number]): string {
  const result = toolCall.result ?? '[tool result missing]'
  const artifact = toolCall.artifactId ? ` artifact=${toolCall.artifactId}` : ''
  return [
    `Tool call [message=${messageId} call=${toolCall.id} name=${toolCall.name}${artifact}]`,
    `Arguments: ${toolCall.arguments}`,
    `Tool result [call=${toolCall.id} name=${toolCall.name}${artifact}]:`,
    result
  ].join('\n')
}

/**
 * 直接从权威 Child Session 渲染证据 transcript。
 * 不走请求投影，因此 request archive/compaction 折叠掉的旧工具结果仍可回读。
 * 若工具结果自身曾经 spill 到 artifact，这里保留 artifactId，交给 artifact_read 续读全文。
 */
function renderEvidenceTranscript(messages: readonly SessionMessage[]): string {
  const chunks: string[] = []
  for (const message of messages) {
    const text = extractTextFromSerializableContent(message.content)
    if (message.role === 'user') {
      chunks.push(`User [message=${message.id}]:\n${text}`)
      continue
    }
    if (message.role === 'assistant') {
      const parts = [`Assistant [message=${message.id}]:\n${text}`]
      for (const toolCall of message.toolCalls ?? []) {
        parts.push(renderToolCall(message.id, toolCall))
      }
      chunks.push(parts.join('\n\n'))
      continue
    }
    if (message.role === 'tool') {
      chunks.push(
        `Tool result [message=${message.id}${message.toolCallId ? ` call=${message.toolCallId}` : ''}]:\n${text}`
      )
    }
  }
  return chunks.join('\n\n')
}

function collectReferencedArtifactIds(messages: readonly SessionMessage[]): string[] {
  return [...new Set(
    messages.flatMap(message =>
      (message.toolCalls ?? []).flatMap(call => call.artifactId ? [call.artifactId] : [])
    )
  )]
}

function isDescendantOf(
  store: SessionStore,
  candidate: SessionData,
  ancestorSessionId: string
): boolean {
  let current: SessionData | null = candidate
  const seen = new Set<string>()

  while (current?.kind === 'subagent') {
    if (seen.has(current.id)) return false
    seen.add(current.id)

    const parentId = current.subagent.lineage.parentSessionId
    if (parentId === ancestorSessionId) return true
    current = store.load(parentId)
  }

  return false
}

function resolveReadableChild(
  context: ToolContext,
  childSessionId: string
): { session: SubagentSessionData } | { error: string } {
  const store = context.sessionStore
  const currentSessionId = context.sessionId
  if (!store || !currentSessionId) {
    return { error: 'subagent_read 需要 sessionStore 与当前 sessionId' }
  }

  const session = store.load(childSessionId)
  if (!session || session.kind !== 'subagent') {
    return { error: '目标子代理会话不存在' }
  }
  if (!isDescendantOf(store, session, currentSessionId)) {
    return { error: '只能读取当前会话派生出的子代理记录' }
  }
  return { session }
}

function parseOperation(value: unknown): SubagentReadOperation | null {
  if (value === undefined || value === '') return 'inspect'
  if (
    value === 'inspect' ||
    value === 'search' ||
    value === 'read' ||
    value === 'artifact_read'
  ) {
    return value
  }
  return null
}

function normalizeReadRange(args: Record<string, unknown>, totalChars: number): {
  offset: number
  limit: number
  end: number
} {
  const rawOffset = typeof args.offset === 'number' && Number.isFinite(args.offset)
    ? Math.floor(args.offset)
    : 0
  const offset = Math.max(0, Math.min(rawOffset, totalChars))
  const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit)
    ? Math.floor(args.limit)
    : DEFAULT_READ_CHARS
  const limit = Math.max(1, Math.min(rawLimit, MAX_READ_CHARS))
  const end = Math.min(offset + limit, totalChars)
  return { offset, limit, end }
}

function buildReadPayload(
  operation: 'read' | 'artifact_read',
  childSessionId: string,
  content: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): ToolResult {
  const { offset, end } = normalizeReadRange(args, content.length)
  return jsonResult({
    ok: true,
    operation,
    childSessionId,
    ...extra,
    offset,
    limit: end - offset,
    nextOffset: end < content.length ? end : null,
    hasMore: end < content.length,
    totalChars: content.length,
    content: content.slice(offset, end)
  })
}

/**
 * subagent_read — 让父 Agent 按需回到 Child Session 核对原始 Evidence。
 * task/task_followup 仍只返回有界摘要；本工具把摘要变成可回溯索引，而不是复制第二份 evidence store。
 */
export const subagentReadTool: ToolExecutor = {
  name: 'subagent_read',
  description:
    '读取当前会话派生出的子代理持久化记录，用于核对 task/task_followup 摘要背后的原始证据。inspect 查看规模和 artifact，search 定位关键词，read 分页读 child transcript，artifact_read 读取该 child toolCall 明确引用的大输出 artifact 全文；记录保留 message/toolCall/toolName/artifactId，可反向追到具体工具结果。',
  parameters: {
    type: 'object',
    properties: {
      child_session_id: {
        type: 'string',
        description: 'task / batch_task / task_followup 返回的子代理会话 ID'
      },
      operation: {
        type: 'string',
        enum: ['inspect', 'search', 'read', 'artifact_read'],
        default: 'inspect',
        description: 'inspect=查看记录规模，search=关键词定位，read=读 transcript，artifact_read=读取 child toolCall 引用的 artifact 原文'
      },
      query: {
        type: 'string',
        description: 'search 的字面关键词，不区分大小写'
      },
      artifact_id: {
        type: 'string',
        description: 'artifact_read 使用的 artifact ID；必须来自 inspect 或 transcript 中的 artifact=...'
      },
      offset: {
        type: 'number',
        default: 0,
        description: 'read / artifact_read 的 0-based 字符偏移；search 返回的 offset 可直接用于 transcript 回读'
      },
      limit: {
        type: 'number',
        description: `read / artifact_read 最多读取的字符数，默认 ${DEFAULT_READ_CHARS}，最大 ${MAX_READ_CHARS}`
      }
    },
    required: ['child_session_id'],
    additionalProperties: false
  },
  executionMode: 'parallel',
  isConcurrencySafe: () => true,
  maxResultSizeChars: MAX_READ_CHARS + 4_000,

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const childSessionId = typeof args.child_session_id === 'string'
      ? args.child_session_id.trim()
      : ''
    if (!childSessionId) return failure('child_session_id 不能为空')

    const operation = parseOperation(args.operation)
    if (!operation) return failure(`未知 operation: ${String(args.operation)}`)

    const resolved = resolveReadableChild(context, childSessionId)
    if ('error' in resolved) return failure(resolved.error)

    const messages = getSessionActiveMessages(resolved.session)
    const artifactIds = collectReferencedArtifactIds(messages)

    if (operation === 'artifact_read') {
      const artifactId = typeof args.artifact_id === 'string' ? args.artifact_id.trim() : ''
      if (!artifactId || !isSafeArtifactId(artifactId)) {
        return failure('artifact_read 需要合法的 artifact_id')
      }
      if (!artifactIds.includes(artifactId)) {
        return failure('artifact_id 未被该子代理当前 toolCall 记录引用')
      }
      if (!context.artifactStore) {
        return failure('artifact_read 需要 artifactStore')
      }
      try {
        const raw = await context.artifactStore.read(childSessionId, artifactId)
        return buildReadPayload(
          'artifact_read',
          childSessionId,
          raw,
          args,
          { artifactId }
        )
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException
        if (nodeError.code === 'ENOENT') {
          return failure(`子代理 artifact 不存在: ${artifactId}`)
        }
        return failure(`无法读取子代理 artifact: ${(error as Error).message}`)
      }
    }

    const transcript = renderEvidenceTranscript(messages)

    if (operation === 'inspect') {
      const toolCallCount = messages.reduce(
        (sum, message) => sum + (message.toolCalls?.length ?? 0),
        0
      )
      return jsonResult({
        ok: true,
        operation: 'inspect',
        childSessionId,
        profileId: resolved.session.subagent.profile.profileId,
        messageCount: messages.length,
        toolCallCount,
        artifactIds,
        totalChars: transcript.length,
        hint: '用 search + query 定位 transcript 证据；若命中 artifact=...，用 artifact_read 读取该大输出原文。'
      })
    }

    if (operation === 'read') {
      return buildReadPayload('read', childSessionId, transcript, args)
    }

    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) return failure('search 操作需要 query 参数')

    const haystack = transcript.toLowerCase()
    const needle = query.toLowerCase()
    const matches: Array<{ offset: number; snippet: string }> = []
    let totalMatches = 0
    let cursor = 0
    while (cursor <= haystack.length - needle.length) {
      const found = haystack.indexOf(needle, cursor)
      if (found < 0) break
      totalMatches += 1
      if (matches.length < MAX_SEARCH_MATCHES) {
        const start = Math.max(0, found - SEARCH_CONTEXT_CHARS)
        const end = Math.min(
          transcript.length,
          found + needle.length + SEARCH_CONTEXT_CHARS
        )
        matches.push({ offset: found, snippet: transcript.slice(start, end) })
      }
      cursor = found + Math.max(needle.length, 1)
    }

    return jsonResult({
      ok: true,
      operation: 'search',
      childSessionId,
      query,
      totalMatches,
      truncated: totalMatches > matches.length,
      matches,
      hint: matches.length > 0
        ? '用 read 在命中 offset 附近核对完整 transcript；若片段带 artifact=...，改用 artifact_read。'
        : '未命中；可先 inspect，再从 offset=0 分页 read。'
    })
  }
}

export default subagentReadTool
