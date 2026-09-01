import { createHash } from 'node:crypto'
import type { ToolContext, ToolExecutor, ToolResult } from '../types'
import {
  assertBatchInputReadonlyEligibility,
  BatchReadonlyEligibilityError,
  SUBAGENT_WALL_CLOCK_TIMEOUT_MS,
  type SpawnSubagentPort
} from '../../subagents'
import {
  decodeBatchInput,
  SubagentBatchDecodeError,
  type BatchSubagentItemResult,
  type BatchSubagentOutput,
  type SpawnSubagentCommand
} from '../../../shared/subagents'

export interface BatchTaskToolDeps {
  readonly getSpawnSubagentPort: () => SpawnSubagentPort | undefined
  readonly loadProfile: (profileId: string, workspaceRoot: string) => unknown
}

export function createBatchTaskTool(deps: BatchTaskToolDeps): ToolExecutor {
  return {
    name: 'batch_task',
    description: '只读并行批次：仅在至少两个子任务独立、非重复且并行有明确收益时使用；2-4个只读子代理并发执行，结果按输入顺序汇总，单项失败不取消兄弟。小任务、顺序依赖、共享写状态与重复展示工作必须直接做或串行。先查询 agent_list/model_list；用户显式指定模型/effort 时严格传递。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          description: '批次项（2-4项），每项含稳定 itemId、profileId、task、可选 canonical 模型覆盖',
          items: {
            type: 'object',
            properties: {
              itemId: { type: 'string', description: '稳定项标识（批次内唯一，不可为空）' },
              profileId: { type: 'string', description: '稳定 profileId（仅只读 profile 可进入批次）' },
              task: { type: 'string', description: '子任务描述（非空，≤8192）' },
              model: {
                type: 'object',
                description: '可选 canonical 模型覆盖，仅改变模型路由',
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
                description: '可选思考强度覆盖'
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
      const batchDigest = createHash('sha256')
        .update(decoded.items.map((entry) => `${entry.itemId}\0${entry.profileId}\0${entry.task}`).join('\0'))
        .digest('hex')
        .slice(0, 8)

      const promises = resolvedItems.map(async ({ item, profile }) => {
        const perItemToolCallId = `${invocationRef.toolCallId}:batch:${batchDigest}:${item.itemId}`
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

      const hasFailure = ordered.some((entry) => entry.status !== 'completed')
      const payload: BatchSubagentOutput = { results: ordered }
      const output = JSON.stringify(payload, null, 2)
      if (hasFailure) {
        // 默认 all-settled：部分失败不取消兄弟，已完成结果保留；整体标记失败但仍返回汇总
        return { success: false, output, error: `批次部分失败：${ordered.filter((e) => e.status !== 'completed').map((e) => `${e.itemId}:${e.status}`).join(', ')}` }
      }
      return { success: true, output }
    }
  }
}

function failure(error: string): ToolResult {
  return { success: false, output: '', error }
}
