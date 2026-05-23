import type { Message, MessageBlock, ToolBlock } from '../../shared/session'
import type { SessionMessage } from '../../runtime/sessions/types'

function parseToolArguments(argumentsValue: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (!argumentsValue) {
    return {}
  }

  if (typeof argumentsValue !== 'string') {
    return argumentsValue
  }

  try {
    return JSON.parse(argumentsValue)
  } catch {
    return {}
  }
}

function normalizeBlocks(blocks: SessionMessage['blocks']): MessageBlock[] | undefined {
  if (!blocks || blocks.length === 0) {
    return undefined
  }

  return blocks.map((block) => {
    if (block.type !== 'tool') {
      return block
    }

    const toolBlock: ToolBlock = {
      ...block,
      arguments: parseToolArguments(block.arguments as string | Record<string, unknown> | undefined)
    }
    return toolBlock
  })
}

/** 将持久化 SessionMessage 转换为共享 Message 格式，顺带恢复工具结果与顺序 blocks */
export function toSharedMessage(
  msg: SessionMessage
): Message & { _toolCallResults?: Record<string, string> } {
  const toolCallResults: Record<string, string> = {}
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      if (tc.result !== undefined) {
        toolCallResults[tc.id] = tc.result
      }
    }
  }

  return {
    id: msg.id,
    sessionId: '',
    role: msg.role,
    content: msg.content,
    toolCalls: msg.toolCalls?.map(tc => ({
      id: tc.id,
      name: tc.name,
      arguments: parseToolArguments(tc.arguments)
    })),
    blocks: normalizeBlocks(msg.blocks),
    verificationSummary: msg.verificationSummary,
    timestamp: msg.timestamp,
    _toolCallResults: Object.keys(toolCallResults).length > 0 ? toolCallResults : undefined
  }
}
