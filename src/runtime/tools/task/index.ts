import type { ReasoningEffort } from '../../../shared/config'
import { BUILTIN_SUBAGENT_IDS } from '../../../shared/subagents/presetIdentity'
import { SUBAGENT_WALL_CLOCK_TIMEOUT_MS, type SpawnSubagentPort } from '../../subagents'
import { buildSubagentToolResult } from '../../subagents/resultText'
import type { ToolContext, ToolExecutor, ToolResult } from '../types'

function failure(error: string): ToolResult {
  return { success: false, output: '', error }
}

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
    description: 'Launch a subagent to complete a subtask. Subagents run in a clean context and return results as a summary. Prefer explore/code/review for specialized tasks; general-purpose is only for mixed tasks that do not fit pure exploration/coding/review. Under XForge, use critic to poke holes in the one-pager and inspector for independent verification.',
    parameters: {
      type: 'object',
      properties: {
        subagent_type: { type: 'string', description: 'The subagent type, e.g. explore / code / review / general-purpose / critic / inspector' },
        task: { type: 'string', description: 'The subtask description' },
        background: {
          type: 'boolean',
          description: 'Optional background execution: returns an acceptance handle immediately and continues the parent task; results arrive later as a background notification. Background tasks are forced read-only and may not write to the workspace'
        },
        model: {
          type: 'object',
          description: 'Optional canonical model override; changes only model routing, not the profile prompt/tools/permissions/isolation',
          properties: {
            providerId: { type: 'string', description: 'The target providerId' },
            modelEntryId: { type: 'string', description: 'The target modelEntryId' }
          },
          required: ['providerId', 'modelEntryId'],
          additionalProperties: false
        },
        reasoningEffort: {
          type: 'string',
          description: 'Optional reasoning-effort override (auto/low/medium/high/max); changes only the reasoning effort',
          enum: ['auto', 'low', 'medium', 'high', 'max']
        }
      },
      required: ['subagent_type', 'task'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const extraKeys = Object.keys(args).filter(
        key => !['subagent_type', 'task', 'background', 'model', 'reasoningEffort'].includes(key)
      )
      if (extraKeys.length > 0) {
        return failure(`未知字段：${extraKeys.join(', ')}`)
      }
      if (args.background !== undefined && typeof args.background !== 'boolean') {
        return failure('background 必须是布尔值')
      }
      const background = args.background === true
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
            isolation:
              profileId === BUILTIN_SUBAGENT_IDS.explore ||
              profileId === BUILTIN_SUBAGENT_IDS.critic
                ? 'readonly'
                : 'shared',
            ...(background ? { background: true } : {}),
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
