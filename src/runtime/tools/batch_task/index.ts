import type { ToolContext, ToolExecutor, ToolResult } from '../types'
import {
  assertBatchInputReadonlyEligibility,
  BatchReadonlyEligibilityError,
  computeBatchItemDigest,
  deriveBatchItemToolCallId,
  SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
  type SpawnSubagentPort
} from '../../subagents'
import {
  decodeBatchInput,
  formatBatchSubagentOutput,
  SubagentBatchDecodeError,
  type BatchSubagentItemResult,
  type SpawnSubagentCommand
} from '../../../shared/subagents'

export interface BatchTaskToolDeps {
  readonly getSpawnSubagentPort: () => SpawnSubagentPort | undefined
  readonly loadProfile: (profileId: string, workspaceRoot: string) => unknown
}

export function createBatchTaskTool(deps: BatchTaskToolDeps): ToolExecutor {
  return {
    name: 'batch_task',
    description: 'Read-only parallel batch: use only when at least two subtasks are independent, non-duplicative, and parallelism has a clear benefit; 2-4 read-only subagents run concurrently, results are aggregated in input order, and one item\'s failure does not cancel its siblings. Small tasks, sequential dependencies, shared write state, and duplicated presentation work must be done directly or serially. Check agent_list/model_list first; when the user explicitly specifies a model/effort, pass it through strictly.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          description: 'Batch items (2-4); each has a stable itemId, profileId, task, and an optional canonical model override',
          items: {
            type: 'object',
            properties: {
              itemId: { type: 'string', description: 'Stable item identifier (unique within the batch, non-empty)' },
              profileId: { type: 'string', description: 'Stable profileId (only read-only profiles may enter the batch)' },
              task: { type: 'string', description: 'Subtask description (non-empty, ≤8192)' },
              model: {
                type: 'object',
                description: 'Optional canonical model override; changes only model routing',
                properties: {
                  providerId: { type: 'string' },
                  modelEntryId: { type: 'string' }
                },
                required: ['providerId', 'modelEntryId'],
                additionalProperties: false
              },
              reasoningEffort: {
                type: 'string',
                enum: ['auto', 'low', 'medium', 'high', 'max'],
                description: 'Optional reasoning-effort override'
              }
            },
            required: ['itemId', 'profileId', 'task'],
            additionalProperties: false
          }
        }
      },
      required: ['items'],
      additionalProperties: false
    },
    executionMode: 'sequential',
    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const extraKeys = Object.keys(args).filter((key) => key !== 'items')
      if (extraKeys.length > 0) {
        return failure(`未知字段：${extraKeys.join(', ')}`)
      }
      let decoded: ReturnType<typeof decodeBatchInput>
      try {
        decoded = decodeBatchInput(args)
      } catch (error) {
        if (error instanceof SubagentBatchDecodeError) return failure(error.message)
        return failure(error instanceof Error ? error.message : String(error))
      }

      const workspaceRoot = context.workspaceRoot ?? context.workingDir
      const resolvedItems = decoded.items.map((item) => ({
        item,
        profile: deps.loadProfile(item.profileId, workspaceRoot)
      }))
      try {
        for (const entry of resolvedItems) {
          if (entry.profile === undefined || entry.profile === null) {
            throw new BatchReadonlyEligibilityError(entry.item.profileId, `未知子代理类型: ${entry.item.profileId}`)
          }
        }
        assertBatchInputReadonlyEligibility(resolvedItems.map(({ item, profile }) => ({
          profileId: item.profileId,
          rawProfile: profile
        })))
      } catch (error) {
        if (error instanceof BatchReadonlyEligibilityError) return failure(error.message)
        return failure(error instanceof Error ? error.message : String(error))
      }

      const invocationRef = context.invocationRef
      if (!invocationRef) return failure('batch_task 缺少完整 durable 调用身份')
      const port = deps.getSpawnSubagentPort()
      if (!port) return failure('子代理执行服务尚未装配')

      // 复用同一 spawn 端口，受 SubagentScheduler 的 global/per-root 容量、FIFO、queue timeout 与 abort 统一控制
      const abortSignal = context.abortSignal
      const inputOrder = decoded.items.map((item) => item.itemId)
      const resultById = new Map<string, Omit<BatchSubagentItemResult, 'itemId'>>()
      // 批次同 toolCall 内的多项需可区分：spawnKey 按 parentToolCallId + batch 派生，保证每项有独立 child 身份
      const batchDigest = computeBatchItemDigest(decoded.items)

      const promises = resolvedItems.map(async ({ item, profile }) => {
        const perItemToolCallId = deriveBatchItemToolCallId(invocationRef.toolCallId, batchDigest, item.itemId)
        const perItemInvocationRef = { ...invocationRef, toolCallId: perItemToolCallId }
        const command: SpawnSubagentCommand = {
          parentSessionId: invocationRef.sessionId,
          parentRunId: invocationRef.runId,
          invocation: {
            kind: 'task_tool',
            parentMessageId: invocationRef.messageId,
            parentToolCallId: perItemToolCallId
          },
          profileId: item.profileId,
          task: item.task,
          workingDirectory: context.workingDir,
          // 批次固定只读
          isolation: 'readonly',
          timeoutMs: SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
          ...(item.model ? { modelOverride: item.model } : {}),
          ...(item.reasoningEffort !== undefined ? { reasoningEffort: item.reasoningEffort } : {})
        }
        try {
          const result = await port.spawn(command, {
            invocationRef: perItemInvocationRef,
            profile,
            waitForCapacity: true,
            ...(abortSignal ? { abortSignal } : {})
          })
          resultById.set(item.itemId, {
            status: result.status,
            summary: result.summary,
            childSessionId: result.childSessionId,
            childRunId: result.childRunId,
            ...(result.failure ? { failure: result.failure } : {}),
            ...(result.incompleteReason ? { incompleteReason: result.incompleteReason } : {})
          })
        } catch (error) {
          // 父取消/排队取消等：若 abort 已触发，不覆盖已取消；此处按失败记录
          const message = error instanceof Error ? error.message : String(error)
          if (abortSignal?.aborted && !resultById.has(item.itemId)) {
            resultById.set(item.itemId, { status: 'cancelled', failure: { code: 'host', message } })
          } else {
            resultById.set(item.itemId, { status: 'rejected', failure: { code: 'host', message } })
          }
        }
      })

      await Promise.allSettled(promises)

      // 按输入顺序汇总
      const ordered: BatchSubagentItemResult[] = inputOrder.map((itemId) => {
        const entry = resultById.get(itemId)
        if (!entry) return { itemId, status: 'rejected', failure: { code: 'host', message: '未知错误' } }
        return { itemId, ...entry }
      })

      const { output, hasFailure, error } = formatBatchSubagentOutput(ordered)
      if (hasFailure) {
        return { success: false, output, error: `工具执行失败: ${error}` }
      }
      return { success: true, output }
    }
  }
}

function failure(error: string): ToolResult {
  return { success: false, output: '', error }
}
