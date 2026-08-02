import type { SpawnSubagentPort } from '../../subagents'
import type { ToolContext, ToolExecutor, ToolResult } from '../types'

export interface TaskToolDeps {
  /** Tool registration precedes per-turn service assembly, so resolution is lazy. */
  readonly getSpawnSubagentPort: () => SpawnSubagentPort | undefined
}

export function createTaskTool(deps: TaskToolDeps): ToolExecutor {
  return {
    name: 'task',
    description: '启动子代理完成子任务。子代理在干净上下文中运行，结果以摘要形式返回。',
    parameters: {
      type: 'object',
      properties: {
        subagent_type: { type: 'string', description: '子代理类型，如 explore / code' },
        task: { type: 'string', description: '子任务描述' }
      },
      required: ['subagent_type', 'task']
    },
    executionMode: 'sequential',
    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const profileId = String(args.subagent_type ?? '').trim()
      const task = String(args.task ?? '').trim()
      if (!profileId) return failure('子代理类型不能为空')
      if (!task) return failure('子任务描述不能为空')

      const invocationRef = context.invocationRef
      if (!invocationRef) {
        return failure('task 工具缺少完整 durable 调用身份')
      }
      const port = deps.getSpawnSubagentPort()
      if (!port) return failure('子代理执行服务尚未装配')

      try {
        const result = await port.spawn(
          {
            parentSessionId: invocationRef.sessionId,
            parentRunId: invocationRef.runId,
            invocation: {
              kind: 'task_tool',
              parentMessageId: invocationRef.messageId,
              parentToolCallId: invocationRef.toolCallId
            },
            profileId,
            task,
            workingDirectory: context.workingDir,
            isolation: profileId === 'explore' ? 'readonly' : 'shared'
          },
          {
            invocationRef,
            ...(context.abortSignal ? { abortSignal: context.abortSignal } : {})
          }
        )
        const output = `[子代理 ${profileId} / ${result.childRunId}]\n${result.summary}`
        if (result.status === 'completed') {
          return { success: true, output }
        }
        return {
          success: false,
          output,
          error: result.failure?.message ?? `子代理执行${statusLabel(result.status)}`
        }
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }
    }
  }
}

function failure(error: string): ToolResult {
  return { success: false, output: '', error }
}

function statusLabel(status: 'failed' | 'cancelled' | 'interrupted'): string {
  switch (status) {
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    case 'interrupted':
      return '已中断'
  }
}
