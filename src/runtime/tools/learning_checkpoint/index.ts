import { randomUUID } from 'crypto'
import type { ToolExecutor } from '../types'
import { claimCheckpointSlot } from '../../learning/progress/checkpointBatchGate'
import {
  getDefaultLearningProgress,
  type LearningProgress
} from '../../learning/progress/LearningProgress'

export interface LearningCheckpointToolDeps {
  getProgress?: () => LearningProgress | null
}

export function createLearningCheckpointTool(
  deps: LearningCheckpointToolDeps = {}
): ToolExecutor {
  const getProgress = deps.getProgress ?? getDefaultLearningProgress

  return {
    name: 'learning_checkpoint',
    description:
      'Persist a complete learning question and frozen rubric, then end the current turn.',
    executionMode: 'sequential',
    isConcurrencySafe: () => false,
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Complete question shown to the user.' },
        cursorVersion: { type: 'integer', description: 'Expected cursor version.' },
        checkpointId: { type: 'string', description: 'Stable checkpoint id for idempotent retries.' }
      },
      required: ['question', 'cursorVersion']
    },
    async execute(args, context) {
      if (context.mode !== 'learn') {
        return { success: false, output: '', error: 'learning_checkpoint 仅用于 learn 会话' }
      }
      const sessionId = context.sessionId
      const runId = context.runId
      const workingDir = context.workingDir
      if (!sessionId || !runId || !workingDir) {
        return { success: false, output: '', error: '缺少 session/run 身份' }
      }
      const question = typeof args.question === 'string' ? args.question.trim() : ''
      if (!question) {
        return { success: false, output: '', error: 'question 不能为空' }
      }
      if (!Number.isSafeInteger(args.cursorVersion) || (args.cursorVersion as number) < 0) {
        return { success: false, output: '', error: 'cursorVersion 无效' }
      }
      const checkpointId =
        typeof args.checkpointId === 'string' && args.checkpointId.trim()
          ? args.checkpointId.trim()
          : randomUUID()

      const slot = claimCheckpointSlot(runId, checkpointId)
      if (slot === 'conflict') {
        return {
          success: false,
          output: '',
          error: '同一轮已存在不同的学习停点，不能再次创建'
        }
      }

      const progress = getProgress()
      if (!progress) {
        return { success: false, output: '', error: '学习停点存储未接入' }
      }

      try {
        await progress.saveCheckpoint({
          workspaceRoot: workingDir,
          sessionId,
          runId,
          checkpointId,
          cursorVersion: args.cursorVersion as number,
          question
        })
      } catch (error) {
        return {
          success: false,
          output: '',
          error: `停点持久化失败: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      return {
        success: true,
        output: JSON.stringify({ checkpointId, persisted: true }),
        control: { type: 'turn_complete' }
      }
    }
  }
}
