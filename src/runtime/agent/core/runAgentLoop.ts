/**
 * 纯 Agent kernel：协调 hooks、压缩、模型流和工具批次，不拥有产品路由与终态协议。
 *
 * 返回循环结束原因，供门面做轮次收尾。不在此发 message_end。
 * - normal：正常结束或 cancelled，门面执行 finishMessageRound
 * - error：终态错误，门面直接收敛失败终态，不启动空闲压缩
 *
 * 关于 cancelled：runAgentLoop 不持有门面的 cancelled 字段。检测到取消
 * （StreamProcessor 返回 cancelled / executeBatch abort / signal）时返回 ended='normal'，
 * 由门面按 cancelled 标志完成 interrupted 收尾。
 */
import type { ChatMessage } from '../../model/types'
import { toToolContent, type ToolBatchExecutionResult } from '../execution/toolBatchExecutor'
import type { HookManager } from './HookManager'
import { getEffectiveToolDefinitions } from './AgentContext'
import type { AgentEvent } from '../types'
import type { AgentContext } from './AgentContext'
import type { AgentLoopConfig, StopReason } from './loopTypes'
import {
  createRequestProjectionArchiveCache,
  projectRequestMessages,
  type ActiveToolResultPrunePolicy,
  type ArchiveCandidate,
  type RequestProjectionArchiveCache,
  type SummaryProjection,
  DISABLED_PRUNE_POLICY
} from './projectRequestMessages'
import type { StreamProcessor } from '../stream/StreamProcessor'
import type { TurnStreamResult } from '../stream/streamTypes'
import { repairEmptyArgsFromContent } from '../stream/nativeArgsRepair'
import { stripTextToolCalls } from '../../../shared/tool-call-text-fallback'
import { ContextBudgetExceededError } from '../ContextBudgetManager'
import { measureRequestPayloadChars } from '../compaction/estimateNextRequestTokens'

/** 将 toolCall.arguments 字符串解析为对象，供空参护栏统计 */
function parseToolCallArgsRecord(argumentsValue: string): Record<string, unknown> {
  const trimmed = (argumentsValue ?? '').trim()
  if (!trimmed || trimmed === '{}') return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 非法 JSON 视为空参
  }
  return {}
}

/**
 * runAgentLoop 入参。
 * 门面装配后传入。executeBatch 由门面构建 options（注入
 * PermissionCoordinator 的权限回调与截断回调 applyTruncation）。
 */
export interface RunAgentLoopParams {
  messageId: string
  /** 本轮 user 文本（beforeAgentStart hook 需要） */
  userText: string
  context: AgentContext
  config: AgentLoopConfig
  streamProcessor: StreamProcessor
  hookManager: HookManager
  emit: (event: AgentEvent) => void
  emitContextBreakdown: (messageId: string, promptTokens: number) => void
  /** 读取取消态（cancelled） */
  signal: () => boolean
  /** 取消信号（透传给 StreamProcessor） */
  abortSignal: () => AbortSignal | undefined
  /** 执行工具批次；门面负责注入权限与截断策略。 */
  executeBatch: (toolCalls: import('../../model/types').ChatToolCall[], messageId: string) => Promise<ToolBatchExecutionResult>
  onToolResultCommitted?: (content: ChatMessage['content']) => void
  /**
   * 主动阈值压缩（请求投影之后调用，摘要输入回放主请求前缀）。
   * 返回 true 表示已压缩，循环应回到顶部重新投影。
   */
  runCompactionIfThreshold: (projection: SummaryProjection) => Promise<boolean>
  /**
   * 工具写回后、下一轮模型请求前的 mid-turn 主动压缩。
   * 编排层保证 fail-open：即便本回调抛错也不终止 turn。
   */
  runMidTurnCompaction?: (projection: SummaryProjection) => Promise<void>
  /** 记录本轮发出请求的 usage 锚点（input tokens + 当时 payload 字符） */
  recordRequestAnchor?: (inputTokens: number, payloadChars: number) => void
  /** 上下文变化后更新压缩 token 簿记 */
  updateTokenEstimate: () => void
  /** 指数退避 sleep（透传给 StreamProcessor） */
  sleep: (ms: number) => Promise<void>
  /**
   * 终态错误交给门面统一记录；返回 error 后不再继续循环。
   */
  onTerminalError: (error: string) => void
}

/** 循环结束原因，供门面执行终态收尾。 */
export type LoopEndReason = 'normal' | 'error'

/**
 * 把权威上下文中的工具结果正文写入内容寻址 artifact。
 * 失败契约：表达为 null，不得抛异常（调用方保留原文并计诊断）。
 */
export function createArchiveWriter(
  context: AgentContext
): (candidate: ArchiveCandidate) => Promise<{ artifactId: string } | null> {
  return async (candidate) => {
    if (!context.artifactStore || !context.sessionId) return null
    try {
      const meta = await context.artifactStore.writeContentAddressed(
        context.sessionId,
        candidate.body,
        { toolName: candidate.toolName }
      )
      return { artifactId: meta.id }
    } catch {
      return null
    }
  }
}

/**
 * 压缩摘要投影（契约见 SummaryProjection）：与主请求共用同一策略与归档回调，
 * 活跃轮次传入主请求的 archiveCache 实例；缺省时独立建缓存（空闲压缩路径）。
 */
export function createSummaryProjection(options: {
  context: AgentContext
  policy: ActiveToolResultPrunePolicy | (() => ActiveToolResultPrunePolicy)
  archiveCache?: RequestProjectionArchiveCache
}): SummaryProjection {
  const archive = createArchiveWriter(options.context)
  return {
    project: async messages => {
      const result = await projectRequestMessages({
        messages,
        policy: typeof options.policy === 'function' ? options.policy() : options.policy,
        archiveCache: options.archiveCache ?? createRequestProjectionArchiveCache(),
        archive
      })
      return result.messages
    }
  }
}

/** cancelled=true 时，门面按 interrupted 完成轮次收尾。 */
export interface LoopEndResult {
  ended: LoopEndReason
  /** StreamProcessor 返回 cancelled 或 executeBatch abort 时为 true */
  cancelled?: boolean
  /** 命中停止策略或循环条件耗尽时的原因；模型自然收工（无工具调用）时为 undefined */
  stopReason?: StopReason
}

/** 执行一轮模型与工具循环。 */
export async function runAgentLoop(p: RunAgentLoopParams): Promise<LoopEndResult> {
  const { messageId, userText, context, config, streamProcessor, hookManager, emit } = p
  let toolRound = 0
  let turnCompletedByControl = false
  /** 停止策略 / 循环条件命中时的原因；模型自然收工时为 undefined */
  let stopReason: StopReason | undefined
  const requestProjectionArchiveCache = createRequestProjectionArchiveCache()
  const archiveWriter = createArchiveWriter(context)
  const requestProjectionPolicy = config.requestProjectionPolicy ?? DISABLED_PRUNE_POLICY
  const summaryProjection = createSummaryProjection({
    context,
    policy: requestProjectionPolicy,
    archiveCache: requestProjectionArchiveCache
  })

  try {
    while (toolRound < config.maxToolRounds) {
      if (p.signal()) break

      // beforeAgentStart 可在每次模型调用前改写 messages 或 systemPrompt。
      const beforeAgent = await hookManager.trigger({
        event: 'beforeAgentStart',
        messageId,
        prompt: userText,
        systemPrompt: context.systemPrompt
      })
      if (beforeAgent?.messages) context.messages = beforeAgent.messages
      if (beforeAgent?.systemPrompt) {
        context.systemPrompt = beforeAgent.systemPrompt
        const sysIdx = context.messages.findIndex(m => m.role === 'system')
        if (sysIdx >= 0) {
          context.messages[sysIdx] = { role: 'system', content: beforeAgent.systemPrompt }
        }
      }

      // ── 请求投影（先于压缩检查：摘要输入回放主请求前缀的前提）──
      const tools = getEffectiveToolDefinitions(context)

      // context / preChat 只改写本次请求，不直接替换持久上下文。
      const contextHook = await hookManager.trigger({
        event: 'context',
        messageId,
        messages: [...context.messages]
      })
      let chatMessages = contextHook?.messages ?? context.messages

      const preChatHook = await hookManager.trigger({
        event: 'preChat',
        messageId,
        messages: [...chatMessages]
      })
      chatMessages = preChatHook?.messages ?? chatMessages
      // 请求投影：把本次模型请求看到的消息与权威上下文分离。
      // 投影结果只赋给 chatMessages，绝不写回 context.messages（权威事实保留全文）。
      // enforceInlineBudget 恢复成功后的 continue 会回到循环顶重新执行投影，
      // 天然满足"恢复后重投影"——若未来把恢复改成就地重试，必须显式重新投影。
      const projection = await projectRequestMessages({
        messages: chatMessages,
        policy: requestProjectionPolicy,
        archiveCache: requestProjectionArchiveCache,
        archive: archiveWriter
      })
      chatMessages = projection.messages

      // ── 主动阈值压缩（Service 内部持有 overflow 守卫）──
      // 发生在请求投影之后：摘要输入回放主请求前缀；压缩成功回到循环顶重投影。
      if (await p.runCompactionIfThreshold(summaryProjection)) continue

      // 轮内预算校验：只估算不改写，超预算走压缩恢复链
      if (config.enforceInlineBudget) {
        const budget = config.enforceInlineBudget(chatMessages)
        if (budget.status === 'requires_compaction') {
          const ok = config.runOverflowCompaction
            && (await config.runOverflowCompaction('standard', summaryProjection)
              || await config.runOverflowCompaction('aggressive', summaryProjection))
          if (!ok) {
            throw new ContextBudgetExceededError(budget.estimatedTokens, budget.serializedBytes, true)
          }
          continue
        }
      }
      p.updateTokenEstimate()

      // native 为默认主路径：向 API 下发 tools，由服务端解析各家原生格式（DSML 等）。
      // xml 为兜底路径（用户 override 或 ollama 等本地推理）：不传 tools，
      // 改由 XmlToolScanner 从正文扫描 <invoke>。防空转由 StopPolicyExtension 空参护栏兜底。
      const nativeTools = context.dialect === 'xml' ? undefined : tools

      const requestPayloadChars = measureRequestPayloadChars(chatMessages)
      const turnResult: TurnStreamResult = await streamProcessor.run({
        messageId,
        chatMessages,
        nativeTools,
        context,
        summaryProjection,
        signal: p.abortSignal(),
        isCancelled: () => p.signal(),
        sleep: (ms: number) => p.sleep(ms)
      })

      if (turnResult.kind === 'cancelled') {
        // kernel 不持有门面取消态，只返回信号，由门面执行 interrupted 收尾。
        return { ended: 'normal', cancelled: true }
      }
      if (turnResult.kind === 'retry') {
        continue
      }
      if (turnResult.kind === 'error') {
        // Processor 已触发 onError；门面负责记录终态并完成资源收尾。
        p.onTerminalError(turnResult.error)
        return { ended: 'error' }
      }

      if (turnResult.promptTokens !== undefined && p.recordRequestAnchor) {
        p.recordRequestAnchor(turnResult.promptTokens, requestPayloadChars)
      }

      const {
        assistantContent,
        toolCalls,
        finishReason,
        sawUsage,
        reasoningContent,
        reasoningProviderId
      } =
        turnResult

      const stepOrigin = { messageId, step: toolRound }
      const assistantMsg: ChatMessage = { role: 'assistant', content: assistantContent, origin: stepOrigin }
      if (toolCalls.length > 0) assistantMsg.toolCalls = toolCalls
      // 运行时字段：供后续模型历史回传；不进 UI / SessionMessage.content
      if (reasoningContent) {
        assistantMsg.reasoningContent = reasoningContent
        if (reasoningProviderId) assistantMsg.reasoningProviderId = reasoningProviderId
      }
      context.messages.push(assistantMsg)

      p.updateTokenEstimate()
      if (!sawUsage) {
        p.emitContextBreakdown(messageId, 0)
      }

      await hookManager.trigger({ event: 'postMessage', messageId, message: assistantMsg })

      if (toolCalls.length === 0) {
        const continuation = await config.assistantCompletionPolicy?.({
          messageId,
          toolRound,
          finishReason,
          assistantContent,
          ...(reasoningContent ? { reasoningContent } : {})
        })
        const instruction = continuation?.instruction.trim()
        if (!instruction) break
        context.messages.push({ role: 'user', content: instruction })
        p.updateTokenEstimate()
        continue
      }

      // 尝试从正文恢复 native 工具调用的空参数。
      const repairedIds = repairEmptyArgsFromContent(toolCalls, assistantContent, diagnostic => {
        emit({
          type: 'repair_diagnostic',
          messageId,
          kind: diagnostic.kind,
          toolCallId: diagnostic.toolCallId,
          toolName: diagnostic.toolName
        })
      })
      if (repairedIds.length > 0) {
        assistantMsg.content = stripTextToolCalls(assistantContent)
      }

      // 解析 repair 后的参数，供停止策略的空参护栏统计
      const toolCallsThisRound = toolCalls.map(tc => ({
        name: tc.name,
        args: parseToolCallArgsRecord(tc.arguments)
      }))

      toolRound++
      const batchResult = await p.executeBatch(toolCalls, messageId)

      if (!batchResult.aborted && !p.signal() && !p.abortSignal()?.aborted) {
        for (const outcome of batchResult.outcomes) {
          if (outcome.skippedByAbort) continue
          const content = toToolContent(outcome.resultText, outcome.resultImages)
          context.messages.push({
            role: 'tool',
            content,
            toolCallId: outcome.toolCall.id,
            origin: stepOrigin,
            ...(outcome.artifactId ? { artifactId: outcome.artifactId } : {}),
            ...(outcome.truncationMeta ? { truncationMeta: outcome.truncationMeta } : {})
          })
          p.onToolResultCommitted?.(content)
        }
        p.updateTokenEstimate()
        if (batchResult.outcomes.some(outcome => outcome.control?.type === 'turn_complete')) {
          turnCompletedByControl = true
          break
        }
        // 工具写回后、下一轮模型前：mid-turn 主动压缩。
        // fail-open 由编排层兜底：端口拒绝不得终止 turn，交给后续溢出恢复。
        if (p.runMidTurnCompaction) {
          try {
            await p.runMidTurnCompaction(summaryProjection)
          } catch {
            // mid-turn 只做预防性整形，任何失败都保持原投影继续。
          }
        }
        // 工具批次后轮内预算校验：超预算走压缩恢复链
        if (config.enforceInlineBudget) {
          const projectedAfterTools = await projectRequestMessages({
            messages: context.messages,
            policy: requestProjectionPolicy,
            archiveCache: requestProjectionArchiveCache,
            archive: archiveWriter
          })
          const budget = config.enforceInlineBudget(projectedAfterTools.messages)
          if (budget.status === 'requires_compaction') {
            const ok = config.runOverflowCompaction
              && (await config.runOverflowCompaction('standard', summaryProjection)
                || await config.runOverflowCompaction('aggressive', summaryProjection))
            if (!ok) {
              throw new ContextBudgetExceededError(budget.estimatedTokens, budget.serializedBytes, true)
            }
            continue
          }
        }
      }

      if (batchResult.aborted || p.signal() || p.abortSignal()?.aborted) {
        return { ended: 'normal', cancelled: true }
      }

      const modeTransition = batchResult.outcomes.find(
        outcome => outcome.control?.type === 'mode_transition'
      )?.control
      if (modeTransition?.type === 'mode_transition' && config.getModeTransitionInstruction) {
        const instruction = config.getModeTransitionInstruction(modeTransition).trim()
        if (instruction) {
          context.messages.push({ role: 'user', content: instruction })
          p.updateTokenEstimate()
        }
        // 模式切换是控制面动作，不消耗任务工具轮数；即使发生在上限边界，
        // 也必须保证新模式至少获得一次模型调用来继续当前任务。
        toolRound = Math.max(0, toolRound - 1)
        continue
      }

      // 停止策略在整个 batch 完成后按源顺序判定。
      if (config.shouldStopAfterTurn) {
        const stopDecision = await config.shouldStopAfterTurn({
          messageId,
          toolRound,
          maxToolRounds: config.maxToolRounds,
          toolCallsThisRound,
          outcomes: batchResult.outcomes.map(o => ({
            toolCall: { id: o.toolCall.id, name: o.toolCall.name },
            args: o.args,
            resultText: o.resultText,
            failed: o.failed,
            skippedByAbort: o.skippedByAbort
          }))
        })
        if (stopDecision?.stop) {
          stopReason = stopDecision.reason
          emit({ type: 'text_delta', messageId, delta: stopDecision.notice })
          break
        }
        if (stopDecision) {
          context.messages.push({ role: 'user', content: stopDecision.instruction })
          p.updateTokenEstimate()
        }
      }

      // 继续下一轮（带着工具结果）
    }
  } catch (err) {
    // 非取消异常必须触发 onError，并交给门面完成失败终态。
    // 唯一 emit 点：onTerminalError 内部 emit error（与 turnResult.kind==='error' 路径一致）。
    // 不在此重复 emit，避免同一错误产生两个终态事件。
    if (!p.signal()) {
      const errMsg = (err as Error).message
      await hookManager.trigger({ event: 'onError', messageId, error: errMsg })
      p.onTerminalError(errMsg)
      return { ended: 'error' }
    }
  }

  // 循环条件耗尽（while 判定为 false 而非 break 退出）同样记为 max_rounds。
  // toolRound > 0 排除从未进入循环的配置（模型一次都未被调用，不算轮数耗尽）；
  // signal 提前 break 时 toolRound 尚未触及上限，也不会误判。
  if (
    !turnCompletedByControl &&
    stopReason === undefined &&
    toolRound > 0 &&
    toolRound >= config.maxToolRounds
  ) {
    stopReason = 'max_rounds'
  }
  return { ended: 'normal', ...(stopReason ? { stopReason } : {}) }
}
