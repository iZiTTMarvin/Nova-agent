import type { ChatToolCall } from '../model/types'
import type { ContentBlock } from '../model/types'
import type { CheckpointManager } from '../checkpoints/CheckpointManager'
import type { Mode } from '../../shared/session/types'
import type { SessionStore } from '../sessions/SessionStore'
import type { EventBus } from './EventBus'
import type { ToolRegistry } from '../tools/ToolRegistry'
import type { ToolContext, ToolExecutor, ImageContent, ToolTruncationMeta } from '../tools/types'
import type { ReadState } from '../tools/editTool'
import type { AgentEvent } from './types'
import type { HookManager } from './HookManager'
import { sanitizeToolOutput } from '../../shared/tool-input-sanitizer'

export interface ToolExecutionOutcome {
  index: number
  toolCall: ChatToolCall
  args: Record<string, unknown>
  resultText: string
  resultImages?: ImageContent[]
  /** 大输出 artifact 指针（与 ToolResult.artifactId 对齐） */
  artifactId?: string
  truncationMeta?: ToolTruncationMeta
  skippedByAbort?: boolean
  /**
   * 工具是否以失败告终（执行异常 / success=false / 权限拒绝 / 未注册）。
   * 结构化标记，避免下游（如 AgentLoop 重复失败熔断）从渲染后的中文 resultText
   * 前缀反推失败状态——文案一旦本地化或调整就会让判定静默失效。
   */
  failed?: boolean
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
  /** 会话级状态存储（透传给 ToolContext；不存在时工具走降级） */
  sessionStore?: SessionStore | null
  /** 当前会话 ID（与 sessionStore 配套） */
  sessionId?: string | null
  /** 事件总线（供 todo_write 等向 renderer 推送事件） */
  eventBus?: EventBus | null
  /** bash 工具的自定义 shell 路径（可选） */
  shellPath?: string
  /** bash 工具的 PATH 注入目录（可选） */
  binDirs?: string[]
  /** 会话级 artifact 存储（大输出落盘 + 指针续读） */
  artifactStore?: import('../artifacts/ArtifactStore').ArtifactStore | null
  /** Hook 编排层（preToolUse / postToolUse） */
  hookManager?: HookManager | null
  /**
   * read state：记录"模型已读过的文件 + 当时内容/mtime"。
   * edit/write 的"先读后改"校验依赖它。
   * 每个 AgentLoop 实例持有独立 readState（sub agent 通过 clone 隔离）。
   */
  readState: ReadState
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
    readState: options.readState,
    ...(options.checkpointManager ? { checkpointManager: options.checkpointManager } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    supportsVision: options.supportsVision,
    ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.eventBus ? { eventBus: options.eventBus } : {}),
    ...(options.shellPath ? { shellPath: options.shellPath } : {}),
    ...(options.binDirs && options.binDirs.length > 0 ? { binDirs: options.binDirs } : {}),
    ...(options.artifactStore ? { artifactStore: options.artifactStore } : {})
  }
}

function createErrorOutcome(index: number, toolCall: ChatToolCall, args: Record<string, unknown>, resultText: string): ToolExecutionOutcome {
  return {
    index,
    toolCall,
    args,
    resultText,
    failed: true
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
  // task / bash 必须串行，与 bash 同级
  if (tool.name === 'task' || tool.name === 'bash' || tool.executionMode !== 'parallel') {
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
  let artifactId: string | undefined
  let truncationMeta: ToolTruncationMeta | undefined
  let failed = false

  try {
    const toolResult = await item.tool.execute(item.args, toolContext)
    if (options.abortSignal?.aborted) {
      return {
        outcome: createSkippedOutcome(item.index, item.toolCall, item.args),
        emitted: false
      }
    }

    if (toolResult.success) {
      // 已走 OutputSink / OutputAccumulator 控量并附 artifact 指针时，跳过二次截断
      if (toolResult.artifactId) {
        resultText = toolResult.output
      } else {
        const maxSize = item.tool.maxResultSizeChars
        resultText = maxSize != null
          ? options.applyTruncation(toolResult.output, maxSize)
          : toolResult.output
      }
      resultImages = toolResult.images
      artifactId = toolResult.artifactId
      truncationMeta = toolResult.truncationMeta
    } else {
      resultText = `工具执行失败: ${toolResult.error}`
      failed = true
    }
  } catch (err) {
    resultText = `工具执行失败: ${(err as Error).message}`
    failed = true
  }

  // postToolUse：允许 hook 修改工具结果
  if (options.hookManager) {
    const patched = await options.hookManager.trigger({
      event: 'postToolUse',
      messageId: options.messageId,
      toolCallId: item.toolCall.id,
      toolName: item.toolCall.name,
      toolResult: resultText,
      isError: failed
    })
    if (patched?.content !== undefined) resultText = patched.content
    if (patched?.isError !== undefined) failed = patched.isError
  }

  options.emit({
    type: 'tool_result',
    messageId: options.messageId,
    toolCallId: item.toolCall.id,
    toolName: item.toolCall.name,
    // T02：在主进程 emit 前对工具输出做截断，防止大 result 撑爆渲染端 heap
    result: sanitizeToolOutput(item.toolCall.name, resultText, failed),
    ...(artifactId ? { artifactId } : {}),
    ...(truncationMeta ? { truncationMeta } : {})
  })

  return {
    outcome: {
      index: item.index,
      toolCall: item.toolCall,
      args: item.args,
      resultText,
      resultImages,
      artifactId,
      truncationMeta,
      failed
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
    let args = parseArgs(toolCall.arguments)
    const tool = options.toolRegistry?.getTool(toolCall.name)

    // preToolUse：拦截或修改参数
    if (options.hookManager && tool) {
      const pre = await options.hookManager.trigger({
        event: 'preToolUse',
        messageId: options.messageId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        toolArgs: args
      })
      if (pre?.block) {
        const reason = pre.reason ?? 'hook 拦截'
        const outcome = createErrorOutcome(index, toolCall, args, `工具被 hook 拦截: ${reason}`)
        precheckOutcomes.push(outcome)
        options.emit({
          type: 'tool_result',
          messageId: options.messageId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result: sanitizeToolOutput(toolCall.name, outcome.resultText, true)
        })
        continue
      }
      if (pre?.modifiedArgs) args = { ...args, ...pre.modifiedArgs }
    }

    if (!tool) {
      const outcome = createErrorOutcome(index, toolCall, args, `工具 "${toolCall.name}" 不可用：未注册工具`)
      precheckOutcomes.push(outcome)
      // 失败路径走更激进的 2KB 截断（isError=true）
      options.emit({
        type: 'tool_result',
        messageId: options.messageId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: sanitizeToolOutput(toolCall.name, outcome.resultText, true)
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
      // 失败路径走更激进的 2KB 截断（isError=true）
      options.emit({
        type: 'tool_result',
        messageId: options.messageId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: sanitizeToolOutput(toolCall.name, outcome.resultText, true)
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
