import type { MessageBlock, Mode } from '../../../shared/session/types'
import { isModeHiddenWriteTool } from '../../../shared/session/toolVisibility'

/**
 * 仅最后一个 thinking block 可以继续计时，避免旧思考块也显示“仍在思考”。
 *
 * 参数只取 type，因此声明为结构化最小面：渲染层的块联合是 shared MessageBlock 的超集
 * （含仅存在于渲染期的编排进度块），本策略无需感知具体变体。
 */
export function isActiveThinkingBlock(
  blocks: ReadonlyArray<{ type: MessageBlock['type'] | string }>,
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
