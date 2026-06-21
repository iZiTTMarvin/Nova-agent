/**
 * runAgentLoop — 纯循环驱动（PRD §6.4 / §8 Phase 3）
 *
 * 对标 pi-agent 的 runLoop：纯循环，不认识 SSE / XML / 权限规则。
 * 只做：调 transformContext → 调 StreamProcessor.run 拿一条 assistant 结果 →
 * 调 executeBatch（经 beforeToolCall/afterToolCall）→ 判 shouldStopAfterTurn → 循环。
 * 所有差异行为通过 AgentLoopConfig 回调注入（PRD §0 核心设计理念）。
 *
 * 控制流逐分支对标 AgentLoop.sendMessage 现状（§4.2 伪代码），hook 触发顺序
 * 严格保持 §4.3 清单。任何 emit 时机/payload 改动都会被黄金测试捕获。
 *
 * 返回循环结束原因，供 Facade 做 finishMessageRound 收尾。不在此发 message_end。
 * - normal：正常结束或 cancelled，Facade 走 finishMessageRound（cancelled 时 interrupted）
 * - error：终态错误，Facade 直接 return（S1：不启动 idleTimer）
 *
 * 关于 cancelled：runAgentLoop 不持有 Facade 的 cancelled 字段。检测到取消
 * （StreamProcessor 返回 cancelled / executeBatch abort / signal）时返回 ended='normal'，
 * 由 Facade 据其自身 cancelled 标志走 finishMessageRound(interrupted)。这与现状
 * 「if(this.cancelled) break → finishMessageRound」等价（break 后 cancelled 仍为 true）。
 */
import type { ChatMessage } from '../../model/types'
import { extractTextFromContent } from '../../model/types'
import type { ToolDefinition } from '../../model/types'
import { estimateContextTokens } from '../tokenEstimator'
import { toToolContent, type ToolBatchExecutionResult } from '../toolBatchExecutor'
import type { HookManager } from '../HookManager'
import type { AgentEvent } from '../types'
import type { AgentContext } from './AgentContext'
import type { AgentLoopConfig } from './loopTypes'
import type { StreamProcessor } from '../stream/StreamProcessor'
import type { TurnStreamResult } from '../stream/streamTypes'
import { repairEmptyArgsFromContent } from '../nativeArgsRepair'
import { stripTextToolCalls } from '../../../shared/tool-call-text-fallback'

/**
 * runAgentLoop 入参（PRD §6.4 RunAgentLoopParams）。
 * Facade 装配后传入。executeBatch 由 Facade 构建 options（注入
 * permissionExtension / toolPostProcessExtension 产出的 checkPermission / applyTruncation）。
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
  /** 执行工具批次（Facade 构建 options，注入权限/截断 extension） */
  executeBatch: (toolCalls: import('../../model/types').ChatToolCall[], messageId: string) => Promise<ToolBatchExecutionResult>
  /** 主动阈值压缩（compactionExtension.transformContext 的 Facade 端实现，stream 前调用） */
  runCompactionIfThreshold: () => Promise<void>
  /** 读取溢出压缩守卫态（compressingForOverflow） */
  isCompressingForOverflow: () => boolean
  /** 缓存诊断基线记录（stream 前，对标现状 recordBaseline） */
  recordBaseline: (systemPrompt: string, tools: ToolDefinition[] | undefined) => void
  /** 指数退避 sleep（透传给 StreamProcessor） */
  sleep: (ms: number) => Promise<void>
  /**
   * 终态错误处理（对标现状 error 路径：emit error + state=error + 取消 idleTimer + 不经 finishMessageRound）。
   * 由 Facade 实现 S1 保护。返回 'error' 前 runAgentLoop 会先 emit error + onError hook。
   */
  onTerminalError: (error: string) => void
}

/** 循环结束原因（PRD §6.4）：供 Facade 做 finishMessageRound */
export type LoopEndReason = 'normal' | 'error'

/** runAgentLoop 返回值。cancelled=true 时 Facade 设 cancelled 标志走 finishMessageRound(interrupted) */
export interface LoopEndResult {
  ended: LoopEndReason
  /** StreamProcessor 返回 cancelled 或 executeBatch abort 时为 true */
  cancelled?: boolean
}

/**
 * 纯循环驱动。逐分支对标 sendMessage 现状 L697-916。
 * hook 触发顺序严格保持 §4.3：beforeAgentStart(每轮) → context(每轮) → preChat(每轮)
 * → onError(错误时) → postMessage(每轮) → [工具内 preToolUse/postToolUse] → onCancel(取消时)。
 */
export async function runAgentLoop(p: RunAgentLoopParams): Promise<LoopEndResult> {
  const { messageId, userText, context, config, streamProcessor, hookManager, emit } = p
  let toolRound = 0

  try {
    while (toolRound < config.maxToolRounds) {
      if (p.signal()) break

      // ── beforeAgentStart hook（每轮，可改 messages/systemPrompt；对标现状 L707-720）──
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

      // ── 主动阈值压缩（compactionExtension，!compressingForOverflow 守卫下；对标现状 L722-731）──
      if (!p.isCompressingForOverflow()) {
        await p.runCompactionIfThreshold()
      }

      // ── 工具定义 + 缓存诊断基线（对标现状 L733-741）──
      const tools = context.toolRegistry?.getToolDefinitions()
      const systemPrompt = extractTextFromContent(
        context.messages.find(m => m.role === 'system')?.content ?? ''
      )
      p.recordBaseline(systemPrompt, tools)

      // ── context / preChat hook（每轮，可改 messages；对标现状 L743-755）──
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

      // XML 方言不传 native tools（轻量模型 function calling 能力不足，会返空 arguments 死循环）
      const nativeTools = context.dialect === 'xml' ? undefined : tools

      // ── StreamProcessor.run：流消费 + 事件 + 解析 + 重试/降级/溢出（对标现状 L767-775）──
      const turnResult: TurnStreamResult = await streamProcessor.run({
        messageId,
        chatMessages,
        nativeTools,
        context,
        signal: p.abortSignal(),
        isCancelled: () => p.signal(),
        sleep: (ms: number) => p.sleep(ms)
      })

      // ── 结果分发（逐分支对标现状 L777-792）──
      if (turnResult.kind === 'cancelled') {
        // cancelled：返回 normal，Facade 据自身 cancelled 标志走 finishMessageRound(interrupted)。
        // 等价现状「StreamProcessor 返回 cancelled → loop 设 cancelled=true → break → finishMessageRound」。
        // 此处不设 Facade 的 cancelled（runAgentLoop 不持有它），由 Facade 在收到 cancelled 时设置。
        return { ended: 'normal', cancelled: true }
      }
      if (turnResult.kind === 'retry') {
        continue
      }
      if (turnResult.kind === 'error') {
        // 终态错误（对标现状 L784-792）：emit error 已在 Processor 内完成？——
        // 否。现状 error case 在 sendMessage 内联 emit error。Processor 返回 {error} 后，
        // 由 Facade（onTerminalError）emit error + state=error + 取消 idleTimer。但 onError hook
        // 在 Processor 内已触发（case error/overflow 都先 trigger onError）。
        // 这里补 emit error + onTerminalError，与现状一致。
        p.onTerminalError(turnResult.error)
        return { ended: 'error' }
      }

      // ── assistant 续接（对标现状 L797-829）──
      const { assistantContent, toolCalls, finishReason, sawUsage } = turnResult

      const assistantMsg: ChatMessage = { role: 'assistant', content: assistantContent }
      if (toolCalls.length > 0) assistantMsg.toolCalls = toolCalls
      context.messages.push(assistantMsg)

      context.lastEstimatedTokens = estimateContextTokens(context.messages)
      if (!sawUsage) {
        p.emitContextBreakdown(messageId, 0)
      }

      await hookManager.trigger({ event: 'postMessage', messageId, message: assistantMsg })

      // 没有工具调用，本轮正常结束（对标现状 L817-819）
      if (toolCalls.length === 0 || finishReason !== 'tool_calls') {
        break
      }

      // native 空参修复（对标现状 L825-829）
      const repairedIds = repairEmptyArgsFromContent(toolCalls, assistantContent)
      if (repairedIds.length > 0) {
        assistantMsg.content = stripTextToolCalls(assistantContent)
      }

      // ── 执行工具批次（Facade 构建 options，注入权限/截断 extension；对标现状 L831-856）──
      toolRound++
      const batchResult = await p.executeBatch(toolCalls, messageId)

      // ── tool 结果入栈（对标现状 L858-868）──
      if (!batchResult.aborted && !p.signal() && !p.abortSignal()?.aborted) {
        for (const outcome of batchResult.outcomes) {
          if (outcome.skippedByAbort) continue
          context.messages.push({
            role: 'tool',
            content: toToolContent(outcome.resultText, outcome.resultImages),
            toolCallId: outcome.toolCall.id,
            ...(outcome.artifactId ? { artifactId: outcome.artifactId } : {}),
            ...(outcome.truncationMeta ? { truncationMeta: outcome.truncationMeta } : {})
          })
        }
      }

      // ── abort/cancel 判定（对标现状 L871-874）──
      if (batchResult.aborted || p.signal() || p.abortSignal()?.aborted) {
        return { ended: 'normal', cancelled: true }
      }

      // ── 停止策略（stopPolicyExtension.shouldStopAfterTurn，batch 后整批判定；对标现状 L876-900）──
      // 熔断计数 + maxRounds 提示：保持"batch 之后、整批、按源顺序"语义（并发安全）。
      // 提示文案由 extension 经 emit 下发，时机在 break 之前（与现状一致）。
      if (config.shouldStopAfterTurn) {
        const stopDecision = await config.shouldStopAfterTurn({
          messageId,
          toolRound,
          maxToolRounds: config.maxToolRounds,
          outcomes: batchResult.outcomes.map(o => ({
            toolCall: { id: o.toolCall.id, name: o.toolCall.name },
            args: o.args,
            resultText: o.resultText,
            failed: o.failed
          }))
        })
        if (stopDecision?.stop) {
          emit({ type: 'text_delta', messageId, delta: stopDecision.notice })
          break
        }
      }

      // 继续下一轮（带着工具结果）
    }
  } catch (err) {
    // 现状 L904-916：非 cancel 的异常 → onError hook + emit error + state=error + return（S1）
    // 唯一 emit 点：onTerminalError 内部 emit error（与 turnResult.kind==='error' 路径一致）。
    // 不在此重复 emit，否则 error 事件会被发两次（C1 违规）。
    if (!p.signal()) {
      const errMsg = (err as Error).message
      await hookManager.trigger({ event: 'onError', messageId, error: errMsg })
      p.onTerminalError(errMsg)
      return { ended: 'error' }
    }
  }

  return { ended: 'normal' }
}
