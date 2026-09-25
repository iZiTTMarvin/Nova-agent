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
        attemptId: { type: 'string' },
        checkpointId: { type: 'string' },
        verdict: { type: 'string' },
        summary: { type: 'string' },
        userQuote: { type: 'string' },
        factReferences: { type: 'array' },
        cursorVersion: { type: 'integer' }
      },
      required: ['attemptId', 'checkpointId', 'verdict', 'summary', 'userQuote', 'cursorVersion']
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
          userQuote: args.userQuote,
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
