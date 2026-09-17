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
      '让既有子代理带着已有上下文继续执行，而不是重新 task 从零开始。适用于：上一轮未完成（如已达工具轮数上限）、方向跑偏需要纠正、或需基于既有结论追问细节。child_session_id 取自此前 task / batch_task 结果中返回的会话 ID；profile、模型与权限沿用该子代理既有配置，不可在此覆盖。',
    parameters: {
      type: 'object',
      properties: {
        child_session_id: {
          type: 'string',
          description: '既有子代理的会话 ID，来自此前 task / batch_task 结果中返回的会话 ID'
        },
        task: { type: 'string', description: '追加指令：说明要继续、纠正或追问什么' },
        resume_run_id: {
          type: 'string',
          description:
            '可选：显式指定要恢复的 interrupted 子 run id（来自中断提示）。提供时恢复事实从该 run 派生；不提供保持原语义。'
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
