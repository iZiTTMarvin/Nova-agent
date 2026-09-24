import type { ToolExecutor } from '../types'

export function createLearningAssessTool(): ToolExecutor {
  return {
    name: 'learning_assess',
    description: 'Submit a candidate assessment for an accepted answer with evidence references.',
    executionMode: 'sequential',
    isConcurrencySafe: () => false,
    parameters: {
      type: 'object',
      properties: {
        attemptId: { type: 'string' },
        checkpointId: { type: 'string' },
        summary: { type: 'string' }
      },
      required: ['attemptId', 'checkpointId']
    },
    async execute(args, context) {
      if (context.mode !== 'learn') {
        return { success: false, output: '', error: 'learning_assess 仅用于 learn 会话' }
      }
      const attemptId = typeof args.attemptId === 'string' ? args.attemptId.trim() : ''
      const checkpointId = typeof args.checkpointId === 'string' ? args.checkpointId.trim() : ''
      if (!attemptId || !checkpointId) {
        return { success: false, output: '', error: 'attemptId 与 checkpointId 必填' }
      }
      return {
        success: false,
        output: '',
        error: '评估落盘尚未在本批次实现；请等待后续批次接入 LearningProgress'
      }
    }
  }
}
