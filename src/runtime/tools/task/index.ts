import type { ReasoningEffort } from '../../../shared/config'
import type { SpawnSubagentPort } from '../../subagents'
import type { SubagentExecutionStatus } from '../../../shared/subagents'
import type { TurnTruncationReason } from '../../../shared/run/types'
import type { ToolContext, ToolExecutor, ToolResult } from '../types'

const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = ['auto', 'low', 'medium', 'high', 'max'] as const

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORT_VALUES as readonly string[]).includes(value)
}

function parseModelOverride(raw: unknown): { providerId: string; modelEntryId: string } | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('model 必须是 { providerId, modelEntryId } 对象')
  }
  const obj = raw as Record<string, unknown>
  const providerId = typeof obj.providerId === 'string' ? obj.providerId.trim() : ''
  const modelEntryId = typeof obj.modelEntryId === 'string' ? obj.modelEntryId.trim() : ''
  if (!providerId || !modelEntryId) {
    throw new Error('model 必须是包含非空 providerId 与 modelEntryId 的对象')
  }
  return { providerId, modelEntryId }
}

export interface TaskToolDeps {
  /** Tool registration precedes per-turn service assembly, so resolution is lazy. */
  readonly getSpawnSubagentPort: () => SpawnSubagentPort | undefined
}

export function createTaskTool(deps: TaskToolDeps): ToolExecutor {
  return {
    name: 'task',
    description: '启动子代理完成子任务。子代理在干净上下文中运行，结果以摘要形式返回。优先用 explore/code/review 匹配专业任务，general-purpose 仅用于不适合纯探索/编码/审查的混合任务。',
    parameters: {
      type: 'object',
      properties: {
        subagent_type: { type: 'string', description: '子代理类型，如 explore / code / review / general-purpose' },
        task: { type: 'string', description: '子任务描述' },
        model: {
          type: 'object',
          description: '可选 canonical 模型覆盖，仅改变模型路由，不改变 profile prompt/工具/权限/isolation',
          properties: {
            providerId: { type: 'string', description: '目标 providerId' },
            modelEntryId: { type: 'string', description: '目标 modelEntryId' }
          },
          required: ['providerId', 'modelEntryId'],
          additionalProperties: false
        },
        reasoningEffort: {
          type: 'string',
          description: '可选思考强度覆盖（auto/low/medium/high/max），仅改变推理强度',
          enum: ['auto', 'low', 'medium', 'high', 'max']
        }
      },
      required: ['subagent_type', 'task'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const extraKeys = Object.keys(args).filter(
        key => !['subagent_type', 'task', 'model', 'reasoningEffort'].includes(key)
      )
      if (extraKeys.length > 0) {
        return failure(`未知字段：${extraKeys.join(', ')}`)
      }
      const profileId = String(args.subagent_type ?? '').trim()
      const task = String(args.task ?? '').trim()
      if (!profileId) return failure('子代理类型不能为空')
      if (!task) return failure('子任务描述不能为空')
      let modelOverride: { providerId: string; modelEntryId: string } | undefined
      try {
        modelOverride = parseModelOverride(args.model)
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }
      let reasoningEffort: ReasoningEffort | undefined
      if (args.reasoningEffort !== undefined) {
        if (!isReasoningEffort(args.reasoningEffort)) {
          return failure('reasoningEffort 必须是 auto/low/medium/high/max 之一')
        }
        reasoningEffort = args.reasoningEffort
      }

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
            isolation: profileId === 'explore' ? 'readonly' : 'shared',
            ...(modelOverride ? { modelOverride } : {}),
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
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
          error:
            result.failure?.message ??
            (result.status === 'incomplete'
              ? `子代理未完成任务${describeIncompleteReason(result.incompleteReason)}`
              : `子代理执行${statusLabel(result.status)}`)
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

function statusLabel(status: SubagentExecutionStatus): string {
  switch (status) {
    case 'completed':
      return '成功'
    case 'incomplete':
      return '未完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    case 'interrupted':
      return '已中断'
  }
}

/** 截断原因的可读说明（仅文案；判定不依赖文案） */
function describeIncompleteReason(reason: TurnTruncationReason | undefined): string {
  switch (reason) {
    case 'max_rounds':
      return '（已达工具轮数上限）'
    case 'breaker':
      return '（重复失败已熔断）'
    case 'empty_args':
      return '（连续空参已中断）'
    case 'deadline':
      return '（达到宿主截止时间）'
    default:
      return ''
  }
}
