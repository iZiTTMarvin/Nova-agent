import type { ReasoningEffort } from '../../../shared/config'
import { SUBAGENT_WALL_CLOCK_TIMEOUT_MS, type SpawnSubagentPort } from '../../subagents'
import { buildSubagentToolResult, failure } from '../subagentResultText'
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
        const spawnResult = await port.spawn(
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
            timeoutMs: SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
            ...(modelOverride ? { modelOverride } : {}),
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
          },
          {
            invocationRef,
            ...(context.abortSignal ? { abortSignal: context.abortSignal } : {})
          }
        )
        // 表头暴露 childSessionId：父模型凭它对同一子代理发起 task_followup 续跑
        return buildSubagentToolResult(
          `[子代理 ${profileId} / 会话 ${spawnResult.childSessionId} / run ${spawnResult.childRunId}]`,
          spawnResult
        )
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }
    }
  }
}
