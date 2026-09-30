import type { ToolExecutor } from '../types'
import {
  getDefaultLearningProgress,
  type LearningProgress
} from '../../learning/progress/LearningProgress'
import {
  parseLearningAssessSubmission,
  type LearningAssessSubmission
} from '../../../shared/learning/rubric'

export interface LearningAssessToolDeps {
  getProgress?: () => LearningProgress | null
}

export function createLearningAssessTool(deps: LearningAssessToolDeps = {}): ToolExecutor {
  const getProgress = deps.getProgress ?? getDefaultLearningProgress

  return {
    name: 'learning_assess',
    description: 'Submit a candidate assessment for an accepted answer with evidence references.',
    executionMode: 'sequential',
    isConcurrencySafe: () => false,
    parameters: {
      type: 'object',
      properties: {
        attemptId: { type: 'string', description: '回答尝试 ID' },
        checkpointId: { type: 'string', description: '核对点 ID' },
        verdict: {
          type: 'string',
          enum: ['understanding_observed', 'needs_clarification', 'inconclusive'],
          description: '定性评估结果：understanding_observed（观察到理解）、needs_clarification（需要进一步澄清纠偏）、inconclusive（证据不足/未实质作答）'
        },
        summary: { type: 'string', description: '评估结论的一句话摘要' },
        factReferences: {
          type: 'array',
          description: '引用的项目事实依据；没有大纲时不要填',
          items: {
            type: 'object',
            properties: {
              receiptId: { type: 'string', description: '源码片段凭证 ID' },
              claim: { type: 'string', description: '对应的项目事实主张' }
            },
            required: ['receiptId', 'claim']
          }
        },
        cursorVersion: { type: 'integer', description: '当前学习游标版本' }
      },
      required: ['attemptId', 'checkpointId', 'verdict', 'summary', 'cursorVersion']
    },
    async execute(args, context) {
      if (context.mode !== 'learn') {
        return { success: false, output: '', error: 'learning_assess 仅用于 learn 会话' }
      }
      const sessionId = context.sessionId
      const runId = context.runId
      const workingDir = context.workingDir
      if (!sessionId || !runId || !workingDir) {
        return { success: false, output: '', error: '缺少 session/run 身份' }
      }
      if (!Number.isSafeInteger(args.cursorVersion) || (args.cursorVersion as number) < 0) {
        return { success: false, output: '', error: 'cursorVersion 无效' }
      }
      let submission: LearningAssessSubmission
      try {
        submission = parseLearningAssessSubmission({
          attemptId: args.attemptId,
          checkpointId: args.checkpointId,
          verdict: args.verdict,
          summary: args.summary,
          factReferences: args.factReferences ?? []
        })
      } catch (error) {
        return {
          success: false,
          output: '',
          error: error instanceof Error ? error.message : String(error)
        }
      }
      const progress = getProgress()
      if (!progress) {
        return { success: false, output: '', error: '学习评估存储未接入' }
      }
      try {
        const result = await progress.submitAssessment({
          workspaceRoot: workingDir,
          sessionId,
          runId,
          cursorVersion: args.cursorVersion as number,
          submissionJson: JSON.stringify(submission)
        })
        return { success: true, output: JSON.stringify(result) }
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
