import type { SpawnSubagentPort } from '../../subagents'
import { buildSubagentToolResult } from '../../subagents/resultText'
import { parseFollowupArguments } from '../../../shared/subagents'
import type { ToolContext, ToolExecutor, ToolResult } from '../types'

export interface TaskFollowupToolDeps {
  /** Tool registration precedes per-turn service assembly, so resolution is lazy. */
  readonly getSpawnSubagentPort: () => SpawnSubagentPort | undefined
}

function failure(error: string): ToolResult {
  return { success: false, output: '', error }
}

export function createTaskFollowupTool(deps: TaskFollowupToolDeps): ToolExecutor {
  return {
    name: 'task_followup',
    description:
      'Have an existing subagent continue with its existing context instead of starting over with a fresh task. Use when the previous run did not finish (e.g. it hit the tool-rounds cap), the direction went off course and needs correcting, or you need to drill into details based on existing conclusions. child_session_id comes from the session ID returned in a previous task / batch_task result; profile, model, and permissions follow that subagent\'s existing configuration and cannot be overridden here.',
    parameters: {
      type: 'object',
      properties: {
        child_session_id: {
          type: 'string',
          description: 'The existing subagent session ID, from the session ID returned in a previous task / batch_task result'
        },
        task: { type: 'string', description: 'Follow-up instruction: state what to continue, correct, or drill into' },
        resume_run_id: {
          type: 'string',
          description:
            'Optional: explicitly specify the interrupted sub run id to resume (from the interruption notice). When provided, the resume facts derive from that run; when omitted, the original semantics are kept.'
        }
      },
      required: ['child_session_id', 'task'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const extraKeys = Object.keys(args).filter(
        key => !['child_session_id', 'task', 'resume_run_id'].includes(key)
      )
      if (extraKeys.length > 0) {
        return failure(`未知字段：${extraKeys.join(', ')}`)
      }
      const parsed = parseFollowupArguments(args)
      if (!parsed) return failure('子会话 ID 与追加指令不能为空')

      const invocationRef = context.invocationRef
      if (!invocationRef) {
        return failure('task_followup 工具缺少完整 durable 调用身份')
      }
      const port = deps.getSpawnSubagentPort()
      if (!port) return failure('子代理执行服务尚未装配')

      try {
        const result = await port.followup(
          {
            parentSessionId: invocationRef.sessionId,
            parentRunId: invocationRef.runId,
            previousChildSessionId: parsed.childSessionId,
            parentMessageId: invocationRef.messageId,
            parentToolCallId: invocationRef.toolCallId,
            task: parsed.task,
            ...(parsed.resumeRunId ? { resumeRunId: parsed.resumeRunId } : {})
          },
          {
            invocationRef,
            ...(context.abortSignal ? { abortSignal: context.abortSignal } : {})
          }
        )
        return buildSubagentToolResult(
          `[子代理续跑 / 会话 ${result.childSessionId} / run ${result.childRunId}]`,
          result
        )
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }
    }
  }
}
