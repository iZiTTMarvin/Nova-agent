import type { RunSnapshot } from '../../shared/run/types'
import type { MessageBlock } from '../../shared/session/types'
import { sanitizeToolInput, sanitizeToolOutput } from '../../shared/tool-input-sanitizer'
import type { ExtendedMessage } from '../stores/types'

export function createAssistantMessage(
  sessionId: string,
  messageId: string,
  timestamp = Date.now()
): ExtendedMessage {
  return {
    id: messageId,
    sessionId,
    role: 'assistant',
    content: '',
    toolCalls: [],
    timestamp,
    thinking: '',
    blocks: [],
    _revision: 0,
    turnStartedAt: timestamp
  }
}

function parseTurnDraftBlock(value: Record<string, unknown>): MessageBlock | null {
  if (value.type === 'text' && typeof value.content === 'string') {
    return { type: 'text', content: value.content }
  }
  if (value.type === 'thinking' && typeof value.content === 'string') {
    return {
      type: 'thinking',
      content: value.content,
      ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {})
    }
  }
  if (
    value.type === 'tool' &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    !!value.arguments &&
    typeof value.arguments === 'object' &&
    (value.status === 'running' || value.status === 'success' || value.status === 'error')
  ) {
    return {
      type: 'tool',
      toolCallId: value.toolCallId,
      toolName: value.toolName,
      arguments: value.arguments as Record<string, unknown>,
      status: value.status,
      ...(typeof value.result === 'string' ? { result: value.result } : {})
    }
  }
  if (
    value.type === 'image' &&
    typeof value.fileName === 'string' &&
    typeof value.dataUrl === 'string' &&
    typeof value.mimeType === 'string'
  ) {
    return {
      type: 'image',
      fileName: value.fileName,
      dataUrl: value.dataUrl,
      mimeType: value.mimeType
    }
  }
  return null
}

export function restoreTurnDraftMessage(
  sessionId: string,
  snapshot: RunSnapshot
): ExtendedMessage {
  const message = createAssistantMessage(
    sessionId,
    snapshot.messageId,
    snapshot.turnStartedAt ?? snapshot.createdAt
  )
  const draft = snapshot.turnDraft
  if (
    !draft ||
    draft.finalized ||
    draft.messageId !== snapshot.messageId ||
    !Array.isArray(draft.blocks)
  ) {
    return message
  }

  const blocks = draft.blocks
    .map(parseTurnDraftBlock)
    .filter((block): block is MessageBlock => block !== null)

  const content = blocks
    .filter((block): block is Extract<MessageBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.content)
    .join('')
  const thinking = blocks
    .filter((block): block is Extract<MessageBlock, { type: 'thinking' }> => block.type === 'thinking')
    .map(block => block.content)
    .join('')
  const toolCalls = blocks
    .filter((block): block is Extract<MessageBlock, { type: 'tool' }> => block.type === 'tool')
    .map(block => {
      const isError =
        block.status === 'error' ||
        block.result?.startsWith('工具执行失败') ||
        block.result?.startsWith('权限拒绝:')
      return {
        id: block.toolCallId,
        name: block.toolName,
        arguments: sanitizeToolInput(block.toolName, block.arguments),
        status: isError
          ? 'error' as const
          : block.status === 'running'
            ? 'running' as const
            : 'success' as const,
        ...(block.result !== undefined
          ? { result: sanitizeToolOutput(block.toolName, block.result, isError) }
          : {})
      }
    })

  const restoredBlocks = blocks.map(block => {
    if (block.type !== 'tool') return block
    const isError =
      block.status === 'error' ||
      block.result?.startsWith('工具执行失败') ||
      block.result?.startsWith('权限拒绝:')
    return {
      ...block,
      arguments: sanitizeToolInput(block.toolName, block.arguments),
      ...(block.result !== undefined
        ? { result: sanitizeToolOutput(block.toolName, block.result, isError) }
        : {})
    }
  })

  return {
    ...message,
    content,
    thinking,
    toolCalls,
    blocks: restoredBlocks
  }
}

/**
 * 已持久化的同 id 消息是终态权威。只保留权威快照指向的未持久化消息，
 * 避免同会话切分支时把旧 active path 混入新历史。
 */
export function mergeFocusedSessionMessages(
  persisted: ExtendedMessage[],
  live: ExtendedMessage[],
  activeLiveMessageId: string | null,
  draft: ExtendedMessage | null
): ExtendedMessage[] {
  const persistedIds = new Set(persisted.map(message => message.id))
  const merged = [...persisted]

  for (const message of live) {
    if (message.id === activeLiveMessageId && !persistedIds.has(message.id)) {
      merged.push(message)
    }
  }

  if (draft && !persistedIds.has(draft.id)) {
    const existingIndex = merged.findIndex(message => message.id === draft.id)
    if (existingIndex === -1) {
      merged.push(draft)
    } else {
      const existing = merged[existingIndex]
      const existingHasOutput =
        existing.content.length > 0 ||
        (existing.thinking?.length ?? 0) > 0 ||
        (existing.blocks?.length ?? 0) > 0
      if (!existingHasOutput) {
        merged[existingIndex] = draft
      }
    }
  }

  return merged
}
