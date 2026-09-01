import type { SpawnSubagentPort } from '../../subagents'
import { buildSubagentToolResult, failure } from '../subagentResultText'
import type { ToolContext, ToolExecutor, ToolResult } from '../types'

export interface TaskFollowupToolDeps {
  /** Tool registration precedes per-turn service assembly, so resolution is lazy. */
  readonly getSpawnSubagentPort: () => SpawnSubagentPort | undefined
}

/**
 * task_followup 参数的唯一归一化入口：工具执行与投影侧的 followup 归属索引共用，
 * 字段改名只改这里。接受对象（executor 入参）或 JSON 字符串（持久化 arguments）。
 */
export function parseFollowupArguments(
  raw: unknown
): { childSessionId: string; task: string } | null {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (typeof value !== 'object' || value === null) return null
  const { child_session_id, task } = value as Record<string, unknown>
  if (typeof child_session_id !== 'string' || !child_session_id.trim()) return null
  if (typeof task !== 'string' || !task.trim()) return null
  return { childSessionId: child_session_id.trim(), task: task.trim() }
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
          description: '既有子代理的会话 ID，来自此前 task / batch_task 结果'
        },
        task: { type: 'string', description: '追加指令：说明要继续、纠正或追问什么' }
      },
      required: ['child_session_id', 'task'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const extraKeys = Object.keys(args).filter(
        key => !['child_session_id', 'task'].includes(key)
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
            task: parsed.task
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
