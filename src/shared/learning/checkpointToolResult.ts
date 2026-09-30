/**
 * learning_checkpoint 工具输出的唯一格式：工具用 serialize 写，界面用 parse 读，
 * 据此把核对问题锚定到产生它的那条回复之后。
 */

export const LEARNING_CHECKPOINT_TOOL_NAME = 'learning_checkpoint'

export interface LearningCheckpointToolResult {
  readonly checkpointId: string
  readonly persisted: true
}

export function serializeCheckpointToolResult(checkpointId: string): string {
  const result: LearningCheckpointToolResult = { checkpointId, persisted: true }
  return JSON.stringify(result)
}

/** 解析失败（截断、归档占位、旧格式）返回 null，调用方把问题渲染在对话末尾。 */
export function parseCheckpointToolResult(output: string | undefined): LearningCheckpointToolResult | null {
  if (!output) return null
  try {
    const value = JSON.parse(output) as { checkpointId?: unknown; persisted?: unknown }
    return typeof value.checkpointId === 'string' && value.checkpointId && value.persisted === true
      ? { checkpointId: value.checkpointId, persisted: true }
      : null
  } catch {
    return null
  }
}
