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

/** plan 模式下历史/异常事件里的写入工具卡也不应该重新出现在聊天流里 */
export function shouldRenderToolBlock(mode: Mode, toolName: string): boolean {
  return !isModeHiddenWriteTool(mode, toolName)
}
