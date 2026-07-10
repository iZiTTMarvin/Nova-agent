/**
 * 消息 block 单一事实源 — projection 与兼容序列化（T5-4 / T6-4）
 *
 * 新版本（SessionData.schemaVersion >= 8）消息以有序 blocks 为唯一事实源；
 * content / toolCalls 仅作为加载时 projection 或兼容序列化字段，不在内存双向可写。
 *
 * 旧会话：加载时 normalizeMessageToBlocksSource 按需构造 blocks，不强制启动全量重写。
 * 迁移器骨架：migrations.migrateV7ToV8 + 本模块；保留至少一个发布周期。
 */
import type { MessageBlock, ToolCall } from '../../shared/session'
import type { SessionMessage, SessionToolCall, SerializableContentBlock } from './types'
import { extractTextFromSerializableContent } from './types'

/** 消息 schema 子版本：嵌在 SessionMessage.messageSchemaVersion */
export const MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE = 1

/**
 * 从 blocks 投影出 content 文本（仅 text 块拼接）。
 * 无 blocks 时回退已有 content。
 */
export function projectContentFromBlocks(
  blocks: MessageBlock[] | undefined,
  fallback: string | SerializableContentBlock[] = ''
): string {
  if (!blocks || blocks.length === 0) {
    return typeof fallback === 'string' ? fallback : extractTextFromSerializableContent(fallback)
  }
  return blocks
    .filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
    .map(b => b.content)
    .join('')
}

/**
 * 从 blocks 投影出 toolCalls（兼容 SessionToolCall / shared ToolCall）。
 * 无 tool 块时回退已有 toolCalls。
 * 若 fallback 中同 id 带有 artifactId / truncationMeta，合并保留（blocks 上无这些字段）。
 */
export function projectToolCallsFromBlocks(
  blocks: MessageBlock[] | undefined,
  fallback?: SessionToolCall[]
): SessionToolCall[] | undefined {
  if (!blocks || blocks.length === 0) {
    return fallback
  }
  const fallbackById = new Map((fallback ?? []).map(tc => [tc.id, tc]))
  const fromBlocks: SessionToolCall[] = []
  for (const b of blocks) {
    if (b.type !== 'tool') continue
    const prev = fallbackById.get(b.toolCallId)
    fromBlocks.push({
      id: b.toolCallId,
      name: b.toolName,
      arguments: JSON.stringify(b.arguments ?? {}),
      ...(b.result !== undefined ? { result: b.result } : {}),
      ...(prev?.artifactId ? { artifactId: prev.artifactId } : {}),
      ...(prev?.truncationMeta ? { truncationMeta: prev.truncationMeta } : {})
    })
  }
  return fromBlocks.length > 0 ? fromBlocks : fallback
}

/**
 * 从旧 content + toolCalls 构造 blocks（迁移 / 兼容加载）。
 */
export function buildBlocksFromLegacyFields(message: {
  content: string | SerializableContentBlock[]
  toolCalls?: SessionToolCall[]
  role: SessionMessage['role']
}): MessageBlock[] {
  const blocks: MessageBlock[] = []
  const text =
    typeof message.content === 'string'
      ? message.content
      : extractTextFromSerializableContent(message.content)

  if (text) {
    blocks.push({ type: 'text', content: text })
  }

  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.arguments || '{}') as Record<string, unknown>
      } catch {
        args = {}
      }
      blocks.push({
        type: 'tool',
        toolCallId: tc.id,
        toolName: tc.name,
        arguments: args,
        status: tc.result !== undefined
          ? (String(tc.result).startsWith('工具执行失败') || String(tc.result).startsWith('权限拒绝:')
            ? 'error'
            : 'success')
          : 'running',
        ...(tc.result !== undefined ? { result: tc.result } : {})
      })
    }
  }

  return blocks
}

/**
 * 规范化单条消息为「blocks 为事实源」形态。
 * - 有 blocks：用 projection 覆盖 content/toolCalls（只读投影，不反向写 blocks）
 * - 无 blocks 但有 content/toolCalls：按需构造 blocks，并标记已迁移
 * 不强制写盘；调用方决定是否持久化。
 */
export function normalizeMessageToBlocksSource(message: SessionMessage): SessionMessage {
  if (message.blocks && message.blocks.length > 0) {
    const content = projectContentFromBlocks(message.blocks, message.content)
    const toolCalls = projectToolCallsFromBlocks(message.blocks, message.toolCalls)
    return {
      ...message,
      content,
      ...(toolCalls ? { toolCalls } : { toolCalls: undefined }),
      messageSchemaVersion: message.messageSchemaVersion ?? MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE
    }
  }

  // 旧消息：从 content/toolCalls 构造 blocks
  const blocks = buildBlocksFromLegacyFields(message)
  if (blocks.length === 0) {
    return {
      ...message,
      messageSchemaVersion: message.messageSchemaVersion ?? MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE
    }
  }

  return {
    ...message,
    blocks,
    // content/toolCalls 保留作兼容序列化，但语义上是 projection
    content: projectContentFromBlocks(blocks, message.content),
    toolCalls: projectToolCallsFromBlocks(blocks, message.toolCalls),
    messageSchemaVersion: MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE
  }
}

/**
 * 新写入落盘形态：blocks 为正文事实源，不双写 content。
 * toolCalls 仅保留 artifactId / truncationMeta 等无法放入 blocks 的旁路元数据。
 * 读取时由 normalizeMessageToBlocksSource 投影 content，并合并 artifact 元数据。
 */
export function serializeMessageForDisk(message: SessionMessage): SessionMessage {
  const normalized = normalizeMessageToBlocksSource(message)
  if (!normalized.blocks || normalized.blocks.length === 0) {
    // 无 blocks 的旧形态：保留 content 以便可读
    return normalized
  }
  const metaToolCalls = (normalized.toolCalls ?? [])
    .filter(tc => tc.artifactId || tc.truncationMeta)
    .map(tc => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      ...(tc.result !== undefined ? { result: tc.result } : {}),
      ...(tc.artifactId ? { artifactId: tc.artifactId } : {}),
      ...(tc.truncationMeta ? { truncationMeta: tc.truncationMeta } : {})
    }))
  return {
    ...normalized,
    // 磁盘正文事实源：blocks；content 置空，加载时再投影
    content: '',
    ...(metaToolCalls.length > 0 ? { toolCalls: metaToolCalls } : { toolCalls: undefined }),
    messageSchemaVersion: MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE
  }
}

/**
 * 从有序 blocks 构建用于持久化的 assistant 消息字段。
 * 调用方应只维护 blocks，再由此投影 content/toolCalls。
 */
export function projectAssistantFieldsFromBlocks(blocks: MessageBlock[]): {
  content: string
  toolCalls: SessionToolCall[] | undefined
  blocks: MessageBlock[]
} {
  return {
    content: projectContentFromBlocks(blocks),
    toolCalls: projectToolCallsFromBlocks(blocks),
    blocks
  }
}

/** shared ToolCall[] 投影（渲染层用） */
export function projectSharedToolCallsFromBlocks(
  blocks: MessageBlock[] | undefined
): ToolCall[] | undefined {
  if (!blocks) return undefined
  const list: ToolCall[] = []
  for (const b of blocks) {
    if (b.type !== 'tool') continue
    list.push({
      id: b.toolCallId,
      name: b.toolName,
      arguments: b.arguments ?? {}
    })
  }
  return list.length > 0 ? list : undefined
}
