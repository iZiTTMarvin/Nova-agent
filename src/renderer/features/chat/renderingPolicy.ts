import type { MessageBlock, Mode } from '../../../shared/session/types'
import { isModeHiddenWriteTool } from '../../../shared/session/toolVisibility'

/** 仅最后一个 thinking block 可以继续计时，避免旧思考块也显示“仍在思考” */
export function isActiveThinkingBlock(
  blocks: MessageBlock[],
  index: number,
  isGenerating: boolean,
  messageId: string,
  currentGeneratingMessageId: string | null
): boolean {
  if (!isGenerating || messageId !== currentGeneratingMessageId) {
    return false
  }

  return index === blocks.length - 1 && blocks[index]?.type === 'thinking'
}

/** 权限拒绝属于模式保护兜底，不应该再把大段参数暴露给用户 */
export function isPermissionDeniedResult(result?: string): boolean {
  return Boolean(result?.startsWith('权限拒绝:'))
}

/** 不在消息流里渲染的工具：plan 模式隐藏写入类，以及由会话级面板统一展示的 todo_write */
export function shouldRenderToolBlock(mode: Mode, toolName: string): boolean {
  if (toolName === 'todo_write') return false
  return !isModeHiddenWriteTool(mode, toolName)
}
