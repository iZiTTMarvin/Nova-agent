/**
 * 会话 → Markdown 导出格式化：给人看的文本，不是数据交换格式。
 *
 * 规则：用户/助手分段；代码块原样；思考块跳过；工具调用折叠为一行摘要
 * （不塞完整 JSON）；归档的大结果显示为固定标注。只导出激活路径——
 * 调用方（主进程）负责用 computeActivePath 选出消息，这里不做树解析。
 */
import type { MessageBlock } from '../../shared/session/types'
import type { SessionMessage } from './types'
import { isArchivedPlaceholder } from '../request-projection'

function toolCallSummary(block: Extract<MessageBlock, { type: 'tool' }>): string {
  const statusMark = block.status === 'success' ? '✓' : block.status === 'error' ? '✗' : '…'
  const primary =
    typeof block.arguments?.path === 'string'
      ? block.arguments.path
      : typeof block.arguments?.file_path === 'string'
        ? block.arguments.file_path
        : typeof block.arguments?.command === 'string'
          ? block.arguments.command.slice(0, 60)
          : typeof block.arguments?.query === 'string'
            ? block.arguments.query.slice(0, 60)
            : ''
  return primary ? `\`${block.toolName} ${primary}\` ${statusMark}` : `\`${block.toolName}\` ${statusMark}`
}

function blocksToMarkdown(blocks: MessageBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'thinking') continue
    if (block.type === 'text' && block.content) {
      parts.push(block.content)
      continue
    }
    if (block.type === 'tool') {
      if (typeof block.result === 'string' && isArchivedPlaceholder(block.result)) {
        parts.push('[大段输出已归档]')
        continue
      }
      parts.push(`> ${toolCallSummary(block)}`)
      continue
    }
    if (block.type === 'image') {
      parts.push(`[图片：${block.fileName}]`)
    }
  }
  return parts.filter(part => part.trim().length > 0).join('\n\n')
}

/** 激活路径消息 → Markdown 文档；标题可选。 */
export function exportSessionToMarkdown(
  messages: SessionMessage[],
  title?: string
): string {
  const lines: string[] = []
  if (title) lines.push(`# ${title}`, '')
  for (const message of messages) {
    if (message.role === 'user') {
      const text =
        typeof message.content === 'string'
          ? message.content
          : blocksToMarkdown(message.blocks ?? [])
      if (!text.trim()) continue
      lines.push('## 用户', '', text, '')
    } else if (message.role === 'assistant') {
      const body = message.blocks?.length
        ? blocksToMarkdown(message.blocks)
        : typeof message.content === 'string'
          ? message.content
          : ''
      if (!body.trim()) continue
      lines.push('## 助手', '', body, '')
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
