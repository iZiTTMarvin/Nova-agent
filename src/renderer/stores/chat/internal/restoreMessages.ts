import type { MessageBlock, SessionDetail, ToolBlock } from '../../../../shared/session/types'
import { stripTextToolCalls } from '../../../../shared/tool-call-text-fallback'
import { stripMinimaxArtifacts } from '../../../../shared/stream/stripMinimaxArtifacts'
import { sanitizeToolInput, sanitizeToolOutput } from '../../../../shared/tool-input-sanitizer'
import type {
  ExtendedMessage,
  ExtendedToolCall,
  RendererMessageBlock,
  SessionMessagePayload
} from '../types'

/** 根据 tool_result 文本判断工具调用是否失败（与 runtime 文案协议） */
export function getToolCallStatus(result?: string): ExtendedToolCall['status'] {
  if (!result) return 'success'
  return result.startsWith('工具执行失败') || result.startsWith('权限拒绝:')
    ? 'error'
    : 'success'
}

/** 旧会话兼容路径：剥离历史 <think>...</think> 标签，不在 UI 重复展示 */
export function stripLegacyThinkingTags(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/g, '')
}

/**
 * 某些模型会把工具调用误输出成正文里的 JSON / XML 片段。
 * 当后端随后补发真实 tool_call 事件时，这里把那段伪调用从消息文本里剥掉，
 * 避免界面同时出现“黑色 JSON 代码块 / XML + 真实工具卡片”的重复展示。
 */
export function stripInlinePseudoToolCalls(
  content: string,
  blocks: RendererMessageBlock[]
): { content: string; blocks: RendererMessageBlock[] } {
  let cleanedContent = stripMinimaxArtifacts(content)
  cleanedContent = stripTextToolCalls(cleanedContent)
  if (cleanedContent === content) {
    return { content, blocks }
  }

  const nextBlocks = [...blocks]
  for (let i = nextBlocks.length - 1; i >= 0; i--) {
    const block = nextBlocks[i]
    if (block.type !== 'text') continue

    let cleanedBlockText = stripMinimaxArtifacts(block.content)
    cleanedBlockText = stripTextToolCalls(cleanedBlockText)
    if (cleanedBlockText === block.content) break

    if (cleanedBlockText.length === 0) {
      nextBlocks.splice(i, 1)
    } else {
      nextBlocks[i] = { ...block, content: cleanedBlockText }
    }
    break
  }

  return { content: cleanedContent, blocks: nextBlocks }
}

/** 把后端返回的 SessionDetail 消息列表恢复成 ExtendedMessage 数组 */
export function restoreSessionMessages(messages: SessionDetail['messages']): ExtendedMessage[] {
  return messages.map((message) => {
    const payload = message as SessionMessagePayload
    const results = payload._toolCallResults ?? {}
    const sanitizedContent = stripLegacyThinkingTags(message.content)

    const toolCalls = message.toolCalls?.map((toolCall) => {
      const result = results[toolCall.id]
      // 历史消息恢复时对 write/edit 工具的 arguments 做摘要化
      const sanitizedArgs = sanitizeToolInput(toolCall.name, toolCall.arguments)
      // 对工具输出做截断，防止历史消息中的长 result 撑爆 heap
      const isErr = result?.startsWith('工具执行失败') || result?.startsWith('权限拒绝:')
      const sanitizedResult = result ? sanitizeToolOutput(toolCall.name, result, isErr) : result
      return {
        id: toolCall.id,
        name: toolCall.name,
        arguments: sanitizedArgs,
        status: getToolCallStatus(result),
        result: sanitizedResult
      }
    })

    if (message.blocks && message.blocks.length > 0) {
      // 对已有 blocks 中的 tool block arguments 和 result 做摘要化/截断
      const sanitizedBlocks = message.blocks.map(block => {
        if (block.type === 'tool') {
          const blockResult = (block as ToolBlock).result
          const isBlkErr = blockResult?.startsWith('工具执行失败') || blockResult?.startsWith('权限拒绝:')
          return {
            ...block,
            arguments: sanitizeToolInput(block.toolName, block.arguments),
            result: blockResult ? sanitizeToolOutput(block.toolName, blockResult, isBlkErr) : blockResult
          }
        }
        return block
      })
      return { ...message, content: sanitizedContent, toolCalls, blocks: sanitizedBlocks, _revision: 0 }
    }

    // 旧消息无 blocks：从 content 和 toolCalls 构造
    const blocks: MessageBlock[] = []
    if (sanitizedContent) {
      blocks.push({ type: 'text', content: sanitizedContent })
    }
    if (toolCalls) {
      for (const tc of toolCalls) {
        blocks.push({
          type: 'tool',
          toolCallId: tc.id,
          toolName: tc.name,
          arguments: tc.arguments,
          status: tc.status,
          result: tc.result
        })
      }
    }

    return { ...message, content: sanitizedContent, toolCalls, blocks, _revision: 0 }
  })
}
