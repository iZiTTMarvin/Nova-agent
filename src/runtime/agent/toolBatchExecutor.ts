import type { ChatToolCall } from '../model/types'
import type { ContentBlock } from '../model/types'
import type { CheckpointManager } from '../checkpoints/CheckpointManager'
import type { Mode } from '../../shared/session/types'
import type { ToolRegistry } from '../tools/ToolRegistry'
import type { ToolContext, ToolExecutor, ImageContent } from '../tools/types'
import type { AgentEvent } from './types'

export interface ToolExecutionOutcome {
  index: number
  toolCall: ChatToolCall
  args: Record<string, unknown>
  resultText: string
  resultImages?: ImageContent[]
  skippedByAbort?: boolean
}

interface PreparedToolCall {
  index: number
  toolCall: ChatToolCall
  args: Record<string, unknown>
  tool: ToolExecutor
  canParallel: boolean
}

export type ToolBatch =
  | { mode: 'parallel'; items: PreparedToolCall[] }
  | { mode: 'sequential'; items: PreparedToolCall[] }

export interface ToolBatchExecutionResult {
  outcomes: ToolExecutionOutcome[]
  aborted: boolean
}

export interface ToolBatchExecutionOptions {
  toolCalls: ChatToolCall[]
  messageId: string
  toolRegistry: ToolRegistry | null
  workingDir: string
  mode: Mode
  supportsVision: boolean
  checkpointManager: CheckpointManager | null
  abortSignal: AbortSignal | undefined
  checkPermission: (toolName: string, args: Record<string, unknown>, messageId: string) => Promise<{ allowed: boolean; reason: string; aborted?: boolean }>
  emit: (event: AgentEvent) => void
  applyTruncation: (output: string, maxSize: number) => string
  maxParallelToolCalls: number
  toolExecution: 'parallel' | 'sequential'
}

interface ToolRunResult {
  outcome: ToolExecutionOutcome
  emitted: boolean
}

function parseArgs(argsStr: string): Record<string, unknown> {
  try {
    return JSON.parse(argsStr || '{}')
  } catch {
    return {}
  }
}

function buildToolContext(options: ToolBatchExecutionOptions): ToolContext {
  return {
    workingDir: options.workingDir,
    ...(options.checkpointManager ? { checkpointManager: options.checkpointManager } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    supportsVision: options.supportsVision
  }
}

function createErrorOutcome(index: number, toolCall: ChatToolCall, args: Record<string, unknown>, resultText: string): ToolExecutionOutcome {
  return {
    index,
    toolCall,
    args,
    resultText
  }
}

function createSkippedOutcome(index: number, toolCall: ChatToolCall, args: Record<string, unknown>): ToolExecutionOutcome {
  return {
    index,
    toolCall,
    args,
    resultText: '',
    skippedByAbort: true
  }
}

function isConcurrencySafe(tool: ToolExecutor, args: Record<string, unknown>, context: ToolContext): boolean {
  if (tool.executionMode !== 'parallel') {
    return false
  }

  if (!tool.isConcurrencySafe) {
    return false
  }

  try {
    return tool.isConcurrencySafe(args, context)
  } catch {
    return false
  }
}

export function partitionPreparedToolCalls(
  items: PreparedToolCall[],
  toolExecution: 'parallel' | 'sequential'
): ToolBatch[] {
  if (items.length === 0) {
    return []
  }

  if (toolExecution === 'sequential') {
    return items.map(item => ({ mode: 'sequential' as const, items: [item] }))
  }

  const batches: ToolBatch[] = []
  let currentParallel: PreparedToolCall[] = []

  const flushParallel = (): void => {
    if (currentParallel.length > 0) {
      batches.push({ mode: 'parallel', items: currentParallel })
      currentParallel = []
    }
  }

  for (const item of items) {
    if (!item.canParallel) {
      flushParallel()
      batches.push({ mode: 'sequential', items: [item] })
      continue
    }

    currentParallel.push(item)
  }

  flushParallel()
  return batches
}

async function executePreparedToolCall(
  item: PreparedToolCall,
  options: ToolBatchExecutionOptions
): Promise<ToolRunResult> {
  if (options.abortSignal?.aborted) {
    return {
      outcome: createSkippedOutcome(item.index, item.toolCall, item.args),
      emitted: false
    }
  }

  const toolContext = buildToolContext(options)
  let resultText = ''
  let resultImages: ImageContent[] | undefined

  try {
    const toolResult = await item.tool.execute(item.args, toolContext)
    if (options.abortSignal?.aborted) {
      return {
        outcome: createSkippedOutcome(item.index, item.toolCall, item.args),
        emitted: false
      }
    }

    if (toolResult.success) {
      const maxSize = item.tool.maxResultSizeChars
      resultText = maxSize != null
        ? options.applyTruncation(toolResult.output, maxSize)
        : toolResult.output
      resultImages = toolResult.images
    } else {
      resultText = `工具执行失败: ${toolResult.error}`
    }
  } catch (err) {
    resultText = `工具执行失败: ${(err as Error).message}`
  }

  options.emit({
    type: 'tool_result',
    messageId: options.messageId,
    toolCallId: item.toolCall.id,
    toolName: item.toolCall.name,
    result: resultText
  })

  return {
    outcome: {
      index: item.index,
      toolCall: item.toolCall,
      args: item.args,
      resultText,
      resultImages
    },
    emitted: true
  }
}

async function runSequentialBatch(
  items: PreparedToolCall[],
  options: ToolBatchExecutionOptions
): Promise<ToolExecutionOutcome[]> {
  const outcomes: ToolExecutionOutcome[] = []

  for (let i = 0; i < items.length; i++) {
    if (options.abortSignal?.aborted) {
      for (let j = i; j < items.length; j++) {
        outcomes.push(createSkippedOutcome(items[j].index, items[j].toolCall, items[j].args))
      }
      break
    }

    const result = await executePreparedToolCall(items[i], options)
    outcomes.push(result.outcome)

    if (!result.emitted && result.outcome.skippedByAbort) {
      for (let j = i + 1; j < items.length; j++) {
        outcomes.push(createSkippedOutcome(items[j].index, items[j].toolCall, items[j].args))
      }
      break
    }
  }

  return outcomes
}

async function runWithConcurrencyLimit(
  items: PreparedToolCall[],
  limit: number,
  options: ToolBatchExecutionOptions
): Promise<ToolExecutionOutcome[]> {
  const concurrency = Math.max(1, limit)
  const results: Array<ToolExecutionOutcome | undefined> = new Array(items.length)
  let nextIndex = 0
  let activeCount = 0
  let settled = false

  return await new Promise<ToolExecutionOutcome[]>((resolve) => {
    const finish = () => {
      if (settled) return
      if (activeCount > 0) return

      // 填充未启动的任务槽位：abort 导致 maybeStart 提前停止时，
      // 部分任务从未被调度，results 中对应位置仍为 undefined。
      // 正常完成时所有槽位已由 executePreparedToolCall 填充，此循环不产生效果。
      for (let i = 0; i < items.length; i++) {
        if (!results[i]) {
          results[i] = createSkippedOutcome(items[i].index, items[i].toolCall, items[i].args)
        }
      }

      settled = true
      resolve(results.filter((item): item is ToolExecutionOutcome => item !== undefined))
    }

    const maybeStart = () => {
      if (settled) return

      while (activeCount < concurrency && nextIndex < items.length && !options.abortSignal?.aborted) {
        const currentIndex = nextIndex++
        activeCount++

        void (async () => {
          try {
            const result = await executePreparedToolCall(items[currentIndex], options)
            results[currentIndex] = result.outcome
          } finally {
            activeCount--
            maybeStart()
            finish()
          }
        })()
      }

      if (nextIndex >= items.length) {
        finish()
      }
    }

    maybeStart()
  })
}

export async function executeToolBatch(options: ToolBatchExecutionOptions): Promise<ToolBatchExecutionResult> {
  if (options.toolCalls.length === 0) {
    return { outcomes: [], aborted: false }
  }

  const precheckOutcomes: ToolExecutionOutcome[] = []
  const executionCandidates: PreparedToolCall[] = []
  const toolContext = buildToolContext(options)

  for (let index = 0; index < options.toolCalls.length; index++) {
    if (options.abortSignal?.aborted) {
      for (let i = index; i < options.toolCalls.length; i++) {
        const toolCall = options.toolCalls[i]
        precheckOutcomes.push(createSkippedOutcome(i, toolCall, parseArgs(toolCall.arguments)))
      }
      break
    }

    const toolCall = options.toolCalls[index]
    const args = parseArgs(toolCall.arguments)
    const tool = options.toolRegistry?.getTool(toolCall.name)

    if (!tool) {
      const outcome = createErrorOutcome(index, toolCall, args, `工具 "${toolCall.name}" 不可用：未注册工具`)
      precheckOutcomes.push(outcome)
      options.emit({
        type: 'tool_result',
        messageId: options.messageId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: outcome.resultText
      })
      continue
    }

    const permissionResult = await options.checkPermission(toolCall.name, args, options.messageId)
    if (permissionResult.aborted || options.abortSignal?.aborted) {
      for (let i = index; i < options.toolCalls.length; i++) {
        const pendingCall = options.toolCalls[i]
        precheckOutcomes.push(createSkippedOutcome(i, pendingCall, parseArgs(pendingCall.arguments)))
      }
      break
    }

    if (!permissionResult.allowed) {
      const outcome = createErrorOutcome(index, toolCall, args, `权限拒绝: ${permissionResult.reason}`)
      precheckOutcomes.push(outcome)
      options.emit({
        type: 'tool_result',
        messageId: options.messageId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: outcome.resultText
      })
      continue
    }

    executionCandidates.push({
      index,
      toolCall,
      args,
      tool,
      canParallel: options.toolExecution !== 'sequential' && isConcurrencySafe(tool, args, toolContext)
    })
  }

  const batches = partitionPreparedToolCalls(executionCandidates, options.toolExecution)
  const executionOutcomes: ToolExecutionOutcome[] = []
  let aborted = Boolean(options.abortSignal?.aborted)

  for (const batch of batches) {
    if (options.abortSignal?.aborted) {
      aborted = true
      for (const item of batch.items) {
        executionOutcomes.push(createSkippedOutcome(item.index, item.toolCall, item.args))
      }
      continue
    }

    const batchOutcomes = batch.mode === 'parallel'
      ? await runWithConcurrencyLimit(batch.items, options.maxParallelToolCalls, options)
      : await runSequentialBatch(batch.items, options)

    executionOutcomes.push(...batchOutcomes)
    if (options.abortSignal?.aborted || batchOutcomes.some(outcome => outcome.skippedByAbort)) {
      aborted = true
    }
  }

  const outcomes = [...precheckOutcomes, ...executionOutcomes].sort((a, b) => a.index - b.index)
  return { outcomes, aborted }
}

export function toToolContent(resultText: string, resultImages?: ImageContent[]): string | ContentBlock[] {
  if (!resultImages || resultImages.length === 0) {
    return resultText
  }

  return [
    { type: 'text', text: resultText },
    ...resultImages.map(img => ({
      type: 'image_url' as const,
      image_url: {
        url: `data:${img.mimeType};base64,${img.data}`
      }
    }))
  ]
}
