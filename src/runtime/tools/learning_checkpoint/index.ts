import { randomUUID } from 'crypto'
import type { ToolExecutor } from '../types'
import { claimCheckpointSlot, releaseCheckpointSlot } from '../../learning/progress/checkpointBatchGate'
import {
  getDefaultLearningProgress,
  type LearningProgress
} from '../../learning/progress/LearningProgress'
import { parseFrozenCheckpointRubric } from '../../../shared/learning/rubric'
import { serializeCheckpointToolResult } from '../../../shared/learning/checkpointToolResult'

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
        question: {
          type: 'string',
          description: '一句话的核对问题，不加任何前后缀。问因果机制、边界或设计取舍，严禁考察行号、函数签名或字面代码背诵。'
        },
        cursorVersion: { type: 'integer', description: 'Expected cursor version.' },
        checkpointId: { type: 'string', description: 'Stable checkpoint id for idempotent retries.' },
        rubric: {
          type: 'object',
          description: '冻结判据。评估学习者是否理解核心因果逻辑，不要求精确匹配代码字面。',
          properties: {
            targetClaim: {
              type: 'string',
              description: '待核对的核心结论或因果机制。'
            },
            verificationMethod: {
              type: 'string',
              description: '验证机制与因果推演方式。'
            },
            criteria: {
              type: 'string',
              description: '判断学习者是否理解的评判标准。'
            },
            equivalenceHints: {
              type: 'string',
              description: '可接受的同义表达提示。'
            },
            knowledgeRevision: {
              type: 'string',
              description: '关联的教材修订版本标识（可选）。'
            }
          },
          required: ['targetClaim', 'verificationMethod', 'criteria']
        }
      },
      required: ['question', 'cursorVersion', 'rubric']
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
      let rubricJson: string
      try {
        rubricJson = JSON.stringify(parseFrozenCheckpointRubric(args.rubric))
      } catch (error) {
        return {
          success: false,
          output: '',
          error: error instanceof Error ? error.message : String(error)
        }
      }
      const checkpointId =
        typeof args.checkpointId === 'string' && args.checkpointId.trim()
          ? args.checkpointId.trim()
          : randomUUID()

      const progress = getProgress()
      if (!progress) {
        return { success: false, output: '', error: '学习停点存储未接入' }
      }

      // 占坑放在存储就绪之后：claim 之后的失败路径才都能归还名额
      const slot = claimCheckpointSlot(runId, checkpointId)
      if (slot === 'conflict') {
        return {
          success: false,
          output: '',
          error: '同一轮已存在不同的学习停点，不能再次创建'
        }
      }

      try {
        await progress.saveCheckpoint({
          workspaceRoot: workingDir,
          sessionId,
          runId,
          checkpointId,
          cursorVersion: args.cursorVersion as number,
          question,
          rubricJson
        })
      } catch (error) {
        // 持久化失败不占本轮名额，模型换停点 id 重试不该被幽灵槽位挡住
        releaseCheckpointSlot(runId)
        return {
          success: false,
          output: '',
          error: `停点持久化失败: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      return {
        success: true,
        output: serializeCheckpointToolResult(checkpointId),
        control: { type: 'turn_complete' }
      }
    }
  }
}
