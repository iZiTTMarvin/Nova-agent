import type { ToolExecutor } from '../types'

export function createLearningContextTool(): ToolExecutor {
  return {
    name: 'learning_context',
    description: 'Read bounded learning materials, checkpoints, and personal summaries for the current node.',
    executionMode: 'parallel',
    isConcurrencySafe: () => true,
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        page: { type: 'integer' }
      }
    },
    async execute(_args, context) {
      if (context.mode !== 'learn') {
        return { success: false, output: '', error: 'learning_context 仅用于 learn 会话' }
      }
      return {
        success: true,
        output: JSON.stringify({
          status: 'unavailable',
          message: '教材与进度存储将在后续批次接入；当前仅验证权限与契约。'
        })
      }
    }
  }
}
