import type { ChatToolCall } from '../../model/types'
import type { ContentBlock } from '../../model/types'
import type { CheckpointManager } from '../../checkpoints/CheckpointManager'
import type { Mode } from '../../../shared/session/types'
import type { SessionStore } from '../../sessions/SessionStore'
import type { EventBus } from '../EventBus'
import { clearExecutionPathGrants } from '../../permissions/pathAccess'
import type { ToolRegistry } from '../../tools/ToolRegistry'
import type {
  ToolContext,
  ToolExecutor,
  ImageContent,
  ToolInvocationRef,
  ToolTruncationMeta,
  ToolControlSignal,
  ToolProcessHandle,
  NestedToolCallRequest,
  NestedToolCallResult
} from '../../tools/types'
import type { ReadState } from '../../tools/editTool'
import type { AgentEvent } from '../types'
import type { HookManager } from '../core/HookManager'
import type { AskQuestionItem, AskQuestionAnswer } from '../../../shared/askQuestion/types'
import type { PermissionCheckResult } from '../../permissions/PermissionCoordinator'
import {
  parseNativeArguments,
  resolveNativeArguments
} from '../stream/nativeArgsRepair'
import { validateAndRepairToolArgs } from './toolShapeValidation'

export interface ToolExecutionOutcome {
  index: number
  toolCall: ChatToolCall
  args: Record<string, unknown>
  resultText: string
  resultImages?: ImageContent[]
  /** 大输出 artifact 指针（与 ToolResult.artifactId 对齐） */
  artifactId?: string
  truncationMeta?: ToolTruncationMeta
  control?: ToolControlSignal
  /** 运行中进程会话句柄（与 ToolResult.processHandle 对齐，仅供事件/UI 层） */
  processHandle?: ToolProcessHandle
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
  /** 当前 runId，透传给 ToolContext 供运行生命周期和 generation fencing 使用。 */
  runId?: string
  /** root run 的 workspace ownership group，writer lease 只读取此字段。 */
  resourceOwnerRunId?: string
  /** 工作区根，透传给 ToolContext 供写者租约按工作区分桶 */
  workspaceRoot?: string
  mode: Mode
  supportsVision: boolean
  checkpointManager: CheckpointManager | null
  abortSignal: AbortSignal | undefined
  checkPermission: (toolName: string, args: Record<string, unknown>, messageId: string, toolCallId?: string) => Promise<PermissionCheckResult>
  checkBatchPermission?: (
    items: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>,
    messageId: string
  ) => Promise<Map<string, PermissionCheckResult>>
  emit: (event: AgentEvent) => void
  applyTruncation: (output: string, maxSize: number) => string
  maxParallelToolCalls: number
  toolExecution: 'parallel' | 'sequential'
  /** 会话级状态存储（透传给 ToolContext；不存在时工具走降级） */
  sessionStore?: SessionStore | null
  /** 当前会话 ID（与 sessionStore 配套） */
  sessionId?: string | null
  /** 当前轮次使用的模型客户端 */
  modelClient?: ToolContext['modelClient']
  /** 当前轮次的工具解析入口 */
  resolveTool?: ToolContext['resolveTool']
  /** 当前模型上下文窗口 */
  contextWindow?: number
  /** 事件总线（供 todo_write 等向 renderer 推送事件） */
  eventBus?: EventBus | null
  /** bash 工具的自定义 shell 路径（可选） */
  shellPath?: string
  /** bash 工具的 PATH 注入目录（可选） */
  binDirs?: string[]
  /** 会话级 artifact 存储（大输出落盘 + 指针续读） */
  artifactStore?: import('../../artifacts/ArtifactStore').ArtifactStore | null
  /** Hook 编排层（preToolUse / postToolUse） */
  hookManager?: HookManager | null
  /**
   * 工具分组可用性闸门：未激活组内工具即使已注册也拦截。
   * 由 AgentLoop 在注入 ToolAvailability 时提供；测试可直接传入。
   */
  isToolAvailable?: (toolName: string) => boolean
  /** 当前模型可见呈现面；只约束模型直调，嵌套调用由沙箱绑定清单约束。 */
  isToolPresented?: (toolName: string) => boolean
  /**
   * read state：记录"模型已读过的文件 + 当时内容/mtime"。
   * edit/write 的"先读后改"校验依赖它。
   * 每个 AgentLoop 实例持有独立 readState（sub agent 通过 clone 隔离）。
   */
  readState: ReadState
  /**
   * askQuestion 阻塞回调（可选）。透传给 ToolContext，供 askQuestion 工具发起提问。
   * 由宿主按 run 身份注入；未装配交互宿主的 AgentLoop 会降级跳过。
   */
  askQuestion?: (requestId: string, questions: AskQuestionItem[]) => Promise<AskQuestionAnswer[]>
  /** 当前工具调用的计划审阅端口。 */
  requestPlanReview?: ToolContext['requestPlanReview']
  /** Plan/Default 模式切换宿主回调；权限确认在工具执行前完成。 */
  switchMode?: ToolContext['switchMode']
  /**
   * 执行 generation fencing：副作用前校验。
   * 由 AgentLoop 注入，绑定当前 runId/generation。
   */
  assertExecutionCurrent?: () => boolean
  /**
   * 是否允许本批次工具获得嵌套派发入口（run_code 工具桥）。
   * 顶层批次默认允许；嵌套执行固定关闭，防止派发无限递归。
   */
  allowNestedToolDispatch?: boolean
}

interface ToolRunResult {
  outcome: ToolExecutionOutcome
  emitted: boolean
}

function parseArgs(argsStr: string): Record<string, unknown> {
  return parseNativeArguments(argsStr).args
}

/**
 * 嵌套工具派发入口：重入 executeToolBatch（同批次的可用性闸门、权限、取消、
 * 截断与 hook 全部生效），结果只回给调用方工具，不写主对话历史。
 * 事件带上父调用标识供 UI 紧凑活动与诊断使用；嵌套执行自身关闭派发入口。
 */
function createNestedDispatcher(
  options: ToolBatchExecutionOptions,
  parentToolCallId: string
): (request: NestedToolCallRequest) => Promise<NestedToolCallResult> {
  let nestedSeq = 0
  return async request => {
    nestedSeq += 1
    const nestedToolCallId = `${parentToolCallId}#nested-${nestedSeq}`
    const emitNested = (event: AgentEvent): void => {
      if (event.type === 'tool_call' || event.type === 'tool_result') {
        options.emit({ ...event, parentToolCallId })
        return
      }
      options.emit(event)
    }
    emitNested({
      type: 'tool_call',
      messageId: options.messageId,
      toolCallId: nestedToolCallId,
      toolName: request.toolName,
      args: request.args
    })
    const { outcomes } = await executeToolBatch({
      ...options,
      toolCalls: [
        {
          id: nestedToolCallId,
          name: request.toolName,
          arguments: JSON.stringify(request.args)
        }
      ],
      emit: emitNested,
      isToolPresented: undefined,
      allowNestedToolDispatch: false
    })
    const outcome = outcomes[0]
    if (!outcome) {
      return {
        toolCallId: nestedToolCallId,
        toolName: request.toolName,
        success: false,
        output: '',
        error: '嵌套调用未产生结果'
      }
    }
    return {
      toolCallId: nestedToolCallId,
      toolName: request.toolName,
      success: !outcome.failed && !outcome.skippedByAbort,
      output: outcome.resultText,
      ...(outcome.failed || outcome.skippedByAbort ? { error: outcome.resultText || '执行被跳过' } : {})
    }
  }
}

function buildToolContext(
  options: ToolBatchExecutionOptions,
  invocationRef?: ToolInvocationRef,
  nestedDispatch?: (request: NestedToolCallRequest) => Promise<NestedToolCallResult>
): ToolContext {
  return {
    workingDir: options.workingDir,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.resourceOwnerRunId
      ? { resourceOwnerRunId: options.resourceOwnerRunId }
      : {}),
    readState: options.readState,
    ...(options.checkpointManager ? { checkpointManager: options.checkpointManager } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    supportsVision: options.supportsVision,
    ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(invocationRef ? { invocationRef } : {}),
    ...(options.modelClient ? { modelClient: options.modelClient } : {}),
    ...(options.resolveTool ? { resolveTool: options.resolveTool } : {}),
    ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.eventBus ? { eventBus: options.eventBus } : {}),
    ...(options.shellPath ? { shellPath: options.shellPath } : {}),
    ...(options.binDirs && options.binDirs.length > 0 ? { binDirs: options.binDirs } : {}),
    ...(options.artifactStore ? { artifactStore: options.artifactStore } : {}),
    ...(options.askQuestion ? { askQuestion: options.askQuestion } : {}),
    ...(options.requestPlanReview ? { requestPlanReview: options.requestPlanReview } : {}),
    ...(options.switchMode ? { switchMode: options.switchMode } : {}),
    ...(options.assertExecutionCurrent
      ? { assertExecutionCurrent: options.assertExecutionCurrent }
      : {}),
    ...(nestedDispatch ? { dispatchNestedToolCall: nestedDispatch } : {})
  }
}

function hasNonEmptyIdentity(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function buildToolInvocationRef(
  options: ToolBatchExecutionOptions,
  toolCallId?: string
): ToolInvocationRef | undefined {
  if (
    !hasNonEmptyIdentity(options.sessionId) ||
    !hasNonEmptyIdentity(options.runId) ||
    !hasNonEmptyIdentity(options.messageId) ||
    !hasNonEmptyIdentity(toolCallId)
  ) {
    return undefined
  }

  return {
    sessionId: options.sessionId,
    runId: options.runId,
    messageId: options.messageId,
    toolCallId
  }
}

/** 失败回传的最大字符数：错误堆栈关键信息在尾部，超限保留尾部，防止撑爆上下文 */
const TOOL_ERROR_RESULT_MAX_CHARS = 4000

function limitToolErrorText(text: string): string {
  if (text.length <= TOOL_ERROR_RESULT_MAX_CHARS) return text
  // 省略标记内含省略字符数，其位数反过来影响标记长度，迭代到数值稳定
  let omitted = text.length - TOOL_ERROR_RESULT_MAX_CHARS
  for (;;) {
    const marker = `…[已省略前 ${omitted} 字符]\n`
    const next = text.length - (TOOL_ERROR_RESULT_MAX_CHARS - marker.length)
    if (next === omitted) return marker + text.slice(omitted)
    omitted = next
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

function createControlOutcome(
  index: number,
  toolCall: ChatToolCall,
  args: Record<string, unknown>,
  resultText: string,
  control: ToolControlSignal
): ToolExecutionOutcome {
  return { index, toolCall, args, resultText, control, failed: false }
}

function isSuccessfulModeSwitch(outcome: ToolExecutionOutcome): boolean {
  return outcome.control?.type === 'mode_transition' && !outcome.skippedByAbort
}

function createModeSwitchBarrierOutcome(item: PreparedToolCall): ToolExecutionOutcome {
  return createErrorOutcome(
    item.index,
    item.toolCall,
    item.args,
    '模式已切换，当前批次的后续工具未执行。Agent 将在当前任务的下一次模型调用中按新模式重新发起。'
  )
}

function createTurnCompleteBarrierOutcome(
  item: Pick<PreparedToolCall, 'index' | 'toolCall' | 'args'>
): ToolExecutionOutcome {
  return createErrorOutcome(
    item.index,
    item.toolCall,
    item.args,
    '本轮已按用户的计划审阅决定结束，当前批次的后续工具未执行。'
  )
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

  const toolContext = buildToolContext(
    options,
    buildToolInvocationRef(options, item.toolCall.id),
    options.allowNestedToolDispatch === true
      ? createNestedDispatcher(options, item.toolCall.id)
      : undefined
  )
  let resultText = ''
  let resultImages: ImageContent[] | undefined
  let artifactId: string | undefined
  let truncationMeta: ToolTruncationMeta | undefined
  let control: ToolControlSignal | undefined
  let processHandle: ToolProcessHandle | undefined
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
      control = toolResult.control
      processHandle = toolResult.processHandle
    } else {
      // 工具执行失败：仍保留工具已产出的 output（如超时前的部分日志、错误堆栈）。
      // 历史问题：失败分支只回传 error 文案、把 output 整个丢弃，导致模型拿不到任何
      // 可用于自救的信息（例如只看到"命令执行超时"却看不到超时前已经打印的报错），
      // 只能盲目重试。这里把 output 附在 error 之后一起回传。
      const detail =
        typeof toolResult.output === 'string' && toolResult.output.trim().length > 0
          ? `\n${toolResult.output}`
          : ''
      resultText = limitToolErrorText(`工具执行失败: ${toolResult.error}${detail}`)
      failed = true
    }
  } catch (err) {
    resultText = limitToolErrorText(`工具执行失败: ${(err as Error).message}`)
    failed = true
  } finally {
    clearExecutionPathGrants(options.sessionId ?? '', item.toolCall.id)
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
    result: resultText,
    failed,
    ...(artifactId ? { artifactId } : {}),
    ...(truncationMeta ? { truncationMeta } : {}),
    ...(processHandle ? { processHandle } : {})
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
      ...(!failed && control ? { control } : {}),
      ...(processHandle ? { processHandle } : {}),
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

    if (result.outcome.control?.type === 'turn_complete') {
      for (let j = i + 1; j < items.length; j++) {
        const outcome = createTurnCompleteBarrierOutcome(items[j])
        outcomes.push(outcome)
        options.emit({
          type: 'tool_result',
          messageId: options.messageId,
          toolCallId: items[j].toolCall.id,
          toolName: items[j].toolCall.name,
          result: outcome.resultText,
          failed: true
        })
      }
      break
    }

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
  let turnCompleteSeen = false

  return await new Promise<ToolExecutionOutcome[]>((resolve) => {
    const finish = () => {
      if (settled) return
      if (activeCount > 0) return

      // 填充未启动的任务槽位：abort 或 turn_complete 导致 maybeStart 提前停止时，
      // 部分任务从未被调度，results 中对应位置仍为 undefined。
      // 正常完成时所有槽位已由 executePreparedToolCall 填充，此循环不产生效果。
      for (let i = 0; i < items.length; i++) {
        if (!results[i]) {
          if (turnCompleteSeen) {
            const outcome = createTurnCompleteBarrierOutcome(items[i])
            results[i] = outcome
            options.emit({
              type: 'tool_result',
              messageId: options.messageId,
              toolCallId: items[i].toolCall.id,
              toolName: items[i].toolCall.name,
              result: outcome.resultText,
              failed: true
            })
          } else {
            results[i] = createSkippedOutcome(items[i].index, items[i].toolCall, items[i].args)
          }
        }
      }

      settled = true
      resolve(results.filter((item): item is ToolExecutionOutcome => item !== undefined))
    }

    const maybeStart = () => {
      if (settled) return

      while (activeCount < concurrency && nextIndex < items.length && !options.abortSignal?.aborted && !turnCompleteSeen) {
        const currentIndex = nextIndex++
        activeCount++

        void (async () => {
          try {
            const result = await executePreparedToolCall(items[currentIndex], options)
            results[currentIndex] = result.outcome
            if (!turnCompleteSeen && result.outcome.control?.type === 'turn_complete') {
              turnCompleteSeen = true
              maybeStart()
            }
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

  // ── 参数预处理 ──
  // 解析 arguments、修复 native 协议，并优先运行 preToolUse hook，
  // 从而在任何权限校验之前拿到经过 hook 修改后的“最终参数”
  const preparedCalls: Array<{
    index: number
    toolCall: ChatToolCall
    args: Record<string, unknown>
    tool: ToolExecutor | undefined
    precheckOutcome?: ToolExecutionOutcome
  }> = []

  const toolContext = buildToolContext(options)

  for (let index = 0; index < options.toolCalls.length; index++) {
    if (options.abortSignal?.aborted) {
      for (let i = index; i < options.toolCalls.length; i++) {
        const toolCall = options.toolCalls[i]
        preparedCalls.push({
          index: i,
          toolCall,
          args: parseArgs(toolCall.arguments),
          tool: undefined,
          precheckOutcome: createSkippedOutcome(i, toolCall, parseArgs(toolCall.arguments))
        })
      }
      break
    }

    const toolCall = options.toolCalls[index]
    let args = resolveNativeArguments(toolCall, diagnostic => {
      options.emit({ type: 'repair_diagnostic', messageId: options.messageId, ...diagnostic })
    })
    let tool = options.toolRegistry?.getTool(toolCall.name)
    // 精确未命中时尝试大小写自愈：唯一命中则按正确名字走全流程。
    // prepared 中的 toolCall 换成浅拷贝的纠正名（toolCallId 不变，协议配对不受影响），
    // 使下游权限校验、bash 批量分组、工具组闸门与事件统一使用纠正后的名字，
    // 大小写写错不能绕过 bash 等工具的权限策略。
    let resolvedToolCall = toolCall
    if (!tool && options.toolRegistry) {
      const resolution = options.toolRegistry.resolveToolNameCaseInsensitive(toolCall.name)
      if (resolution.kind === 'unique') {
        resolvedToolCall = { ...toolCall, name: resolution.name }
        tool = options.toolRegistry.getTool(resolution.name)
        options.emit({
          type: 'repair_diagnostic',
          messageId: options.messageId,
          kind: 'tool_name_case',
          toolCallId: toolCall.id,
          toolName: resolution.name
        })
      }
    }

    // preToolUse：拦截或修改参数
    let blocked = false
    let blockedOutcome: ToolExecutionOutcome | undefined
    if (options.hookManager && tool) {
      const pre = await options.hookManager.trigger({
        event: 'preToolUse',
        messageId: options.messageId,
        toolCallId: resolvedToolCall.id,
        toolName: resolvedToolCall.name,
        toolArgs: args
      })
      if (pre?.block) {
        blocked = true
        const reason = pre.reason ?? 'hook 拦截'
        blockedOutcome = createErrorOutcome(index, resolvedToolCall, args, `工具被 hook 拦截: ${reason}`)
      }
      if (pre?.modifiedArgs) {
        args = { ...args, ...pre.modifiedArgs }
      }
    }

    if (blocked && blockedOutcome) {
      preparedCalls.push({
        index,
        toolCall: resolvedToolCall,
        args,
        tool,
        precheckOutcome: blockedOutcome
      })
      continue
    }

    if (!tool) {
      const outcome = createErrorOutcome(index, resolvedToolCall, args, `工具 "${resolvedToolCall.name}" 不可用：未注册工具`)
      preparedCalls.push({
        index,
        toolCall: resolvedToolCall,
        args,
        tool: undefined,
        precheckOutcome: outcome
      })
      continue
    }

    if (options.isToolAvailable && !options.isToolAvailable(resolvedToolCall.name)) {
      const outcome = createErrorOutcome(
        index,
        resolvedToolCall,
        args,
        `工具 "${resolvedToolCall.name}" 不可用：所属工具组未激活，请先调用 load_tools`
      )
      preparedCalls.push({
        index,
        toolCall: resolvedToolCall,
        args,
        tool,
        precheckOutcome: outcome
      })
      continue
    }

    if (options.isToolPresented && !options.isToolPresented(resolvedToolCall.name)) {
      const outcome = createErrorOutcome(
        index,
        resolvedToolCall,
        args,
        `工具 "${resolvedToolCall.name}" 不可用：当前工具呈现模式未直接暴露该工具`
      )
      preparedCalls.push({
        index,
        toolCall: resolvedToolCall,
        args,
        tool,
        precheckOutcome: outcome
      })
      continue
    }

    // 形状关卡：按工具 schema 校验参数类型并按证据修复（validate-then-repair）。
    // 只处理 schema 声明且类型不符的字段；别名 / 缺参校验仍归工具本身。
    const shapeChecked = validateAndRepairToolArgs(
      resolvedToolCall.name,
      tool.parameters,
      args,
      kind => {
        options.emit({
          type: 'repair_diagnostic',
          messageId: options.messageId,
          kind,
          toolCallId: resolvedToolCall.id,
          toolName: resolvedToolCall.name
        })
      }
    )
    if (shapeChecked.errorText) {
      preparedCalls.push({
        index,
        toolCall: resolvedToolCall,
        args: shapeChecked.args,
        tool,
        precheckOutcome: createErrorOutcome(index, resolvedToolCall, shapeChecked.args, shapeChecked.errorText)
      })
      continue
    }
    args = shapeChecked.args

    preparedCalls.push({
      index,
      toolCall: resolvedToolCall,
      args,
      tool
    })
  }

  // ── 扫描连续且未被前置拦截的 bash 组进行批量校验 ──
  const bashGroups: Array<Array<{ index: number; toolCall: ChatToolCall; args: Record<string, unknown> }>> = []
  let currentGroup: Array<{ index: number; toolCall: ChatToolCall; args: Record<string, unknown> }> = []

  for (const item of preparedCalls) {
    if (item.toolCall.name === 'bash' && !item.precheckOutcome) {
      currentGroup.push({ index: item.index, toolCall: item.toolCall, args: item.args })
    } else {
      if (currentGroup.length > 0) {
        bashGroups.push(currentGroup)
        currentGroup = []
      }
    }
  }
  if (currentGroup.length > 0) {
    bashGroups.push(currentGroup)
  }

  const permissionResults = new Map<string, PermissionCheckResult>()

  for (const group of bashGroups) {
    if (options.checkBatchPermission) {
      const items = group.map(item => ({
        toolCallId: item.toolCall.id,
        toolName: 'bash',
        args: item.args
      }))
      const batchRes = await options.checkBatchPermission(items, options.messageId)
      for (const [id, res] of batchRes.entries()) {
        permissionResults.set(id, res)
      }
    } else {
      // 降级回退：逐个询问
      for (const item of group) {
        const res = await options.checkPermission(item.toolCall.name, item.args, options.messageId, item.toolCall.id)
        permissionResults.set(item.toolCall.id, res)
      }
    }
  }

  // ── 分发前置拦截、校验最终权限并入队待执行项 ──
  const precheckOutcomes: ToolExecutionOutcome[] = []
  const executionCandidates: PreparedToolCall[] = []
  let turnCompletePermissionIndex: number | null = null

  for (const item of preparedCalls) {
    if (turnCompletePermissionIndex !== null && item.index > turnCompletePermissionIndex) {
      const outcome = createTurnCompleteBarrierOutcome(item)
      precheckOutcomes.push(outcome)
      options.emit({
        type: 'tool_result',
        messageId: options.messageId,
        toolCallId: item.toolCall.id,
        toolName: item.toolCall.name,
        result: outcome.resultText,
        failed: true
      })
      continue
    }

    if (item.precheckOutcome) {
      precheckOutcomes.push(item.precheckOutcome)
      options.emit({
        type: 'tool_result',
        messageId: options.messageId,
        toolCallId: item.toolCall.id,
        toolName: item.toolCall.name,
        result: item.precheckOutcome.resultText,
        failed: true
      })
      continue
    }

    if (options.abortSignal?.aborted) {
      precheckOutcomes.push(createSkippedOutcome(item.index, item.toolCall, item.args))
      continue
    }

    // 运行最终权限校验（此时的 item.args 已是经过 hook 改写后的最新实际参数）
    let permissionResult: PermissionCheckResult
    if (item.toolCall.name === 'bash') {
      permissionResult = permissionResults.get(item.toolCall.id) || { allowed: false, reason: '未找到权限校验结果' }
    } else {
      permissionResult = await options.checkPermission(item.toolCall.name, item.args, options.messageId, item.toolCall.id)
    }

    if (permissionResult.aborted || options.abortSignal?.aborted) {
      for (let i = item.index; i < options.toolCalls.length; i++) {
        const pendingCall = options.toolCalls[i]
        if (!precheckOutcomes.some(o => o.toolCall.id === pendingCall.id) &&
            !executionCandidates.some(c => c.toolCall.id === pendingCall.id)) {
          let pendingArgs = parseArgs(pendingCall.arguments)
          const prepared = preparedCalls.find(p => p.toolCall.id === pendingCall.id)
          if (prepared) pendingArgs = prepared.args
          precheckOutcomes.push(createSkippedOutcome(i, pendingCall, pendingArgs))
        }
      }
      break
    }

    if (!permissionResult.allowed && permissionResult.control?.type === 'turn_complete') {
      const outcome = createControlOutcome(
        item.index,
        item.toolCall,
        item.args,
        permissionResult.reason,
        permissionResult.control
      )
      precheckOutcomes.push(outcome)
      turnCompletePermissionIndex = item.index
      options.emit({
        type: 'tool_result',
        messageId: options.messageId,
        toolCallId: item.toolCall.id,
        toolName: item.toolCall.name,
        result: outcome.resultText,
        failed: false
      })
      continue
    }

    if (!permissionResult.allowed) {
      const outcome = createErrorOutcome(item.index, item.toolCall, item.args, `权限拒绝: ${permissionResult.reason}`)
      precheckOutcomes.push(outcome)
      options.emit({
        type: 'tool_result',
        messageId: options.messageId,
        toolCallId: item.toolCall.id,
        toolName: item.toolCall.name,
        result: outcome.resultText,
        failed: true
      })
      continue
    }

    executionCandidates.push({
      index: item.index,
      toolCall: item.toolCall,
      args: item.args,
      tool: item.tool!,
      canParallel: options.toolExecution !== 'sequential' && isConcurrencySafe(item.tool!, item.args, toolContext)
    })
  }

  const batches = partitionPreparedToolCalls(executionCandidates, options.toolExecution)
  const executionOutcomes: ToolExecutionOutcome[] = []
  let aborted = Boolean(options.abortSignal?.aborted)

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex]
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
    const barrier = batchOutcomes.some(outcome => outcome.control?.type === 'turn_complete')
      ? createTurnCompleteBarrierOutcome
      : batchOutcomes.some(isSuccessfulModeSwitch)
        ? createModeSwitchBarrierOutcome
        : null
    if (barrier) {
      for (const remainingBatch of batches.slice(batchIndex + 1)) {
        for (const item of remainingBatch.items) {
          const outcome = barrier(item)
          executionOutcomes.push(outcome)
          options.emit({
            type: 'tool_result',
            messageId: options.messageId,
            toolCallId: item.toolCall.id,
            toolName: item.toolCall.name,
            result: outcome.resultText,
            failed: true
          })
        }
      }
      break
    }
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
