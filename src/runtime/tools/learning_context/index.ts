import type { ToolExecutor } from '../types'
import {
  getDefaultLearningProgress,
  type LearningProgress
} from '../../learning/progress/LearningProgress'

export interface LearningContextToolDeps {
  getProgress?: () => LearningProgress | null
}

export function createLearningContextTool(
  deps: LearningContextToolDeps = {}
): ToolExecutor {
  const getProgress = deps.getProgress ?? getDefaultLearningProgress

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
    async execute(args, context) {
      if (context.mode !== 'learn') {
        return { success: false, output: '', error: 'learning_context 仅用于 learn 会话' }
      }
      const sessionId = context.sessionId
      const workingDir = context.workingDir
      if (!sessionId || !workingDir) {
        return { success: false, output: '', error: '缺少 session 身份' }
      }
      const progress = getProgress()
      if (!progress) {
        return { success: false, output: '', error: '学习进度存储未接入' }
      }
      const page =
        Number.isSafeInteger(args.page) && (args.page as number) >= 0 ? (args.page as number) : 0
      const nodeId = typeof args.nodeId === 'string' && args.nodeId.trim() ? args.nodeId.trim() : undefined
      try {
        const view = await progress.getLearningContext({
          workspaceRoot: workingDir,
          sessionId,
          nodeId,
          page
        })
        return { success: true, output: JSON.stringify(view) }
      } catch (error) {
        return {
          success: false,
          output: '',
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }
}
