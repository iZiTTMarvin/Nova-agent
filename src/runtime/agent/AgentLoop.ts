/**
 * AgentLoop — 核心消息-模型-工具循环
 * 接收用户消息，组织上下文，调用模型，处理工具调用，通过 EventBus 向外发射流式事件
 *
 * S3 阶段：纯文本对话循环（消息 → 模型 → 响应）
 * S4 阶段：加入工具调度（tool_call → 执行 → 结果回模型 → 重复）
 * S6 阶段：加入 checkpoint 备份和 plan 模式写入拦截
 * S7 阶段：加入 PermissionManager 权限决策
 */
import type { ModelClient } from '../model/ModelClient'
import type { ChatMessage, ChatToolCall, ContentBlock } from '../model/types'
import { extractTextFromContent } from '../model/types'
import type { AgentState, AgentLoopConfig } from './types'
import type { ToolRegistry } from '../tools/ToolRegistry'
import type { CheckpointManager } from '../checkpoints/CheckpointManager'
import type { PermissionManager } from '../permissions/PermissionManager'
import type { SessionStore } from '../sessions/SessionStore'
import type { Mode } from '../../shared/session/types'
import type { TruncationStage } from '../tools/grep-types'
import { createTruncationPipeline } from '../tools/TruncationPipeline'
import { EventBus } from './EventBus'
import { getModeInstruction } from './modeInstruction'
import { shouldCompact, splitForCompaction, buildCompactionPrompt, rebuildWithCompression, MIN_RECENT_MESSAGES, getCompactionThreshold, rollbackBefore } from './compaction'
import { CacheDiagnostics } from '../model/cacheDiagnostics'
import { randomUUID } from 'crypto'
import { estimateContextTokens } from './tokenEstimator'
import { executeToolBatch, toToolContent } from './toolBatchExecutor'

/** 写入类工具名称集合，plan 模式下会被拒绝 */
const WRITE_TOOLS = new Set(['edit', 'write', 'bash'])

/**
 * 表示权限请求被 cancel 中断的 sentinel 错误。
 * 用于 checkPermission 区分"用户主动拒绝"（产生"权限拒绝"工具结果）
 * 和"流程被取消"（不产生任何 tool_result，不污染 context 与持久化）。
 */
class PermissionAbortedError extends Error {
  constructor() {
    super('permission request aborted by cancel')
    this.name = 'PermissionAbortedError'
  }
}

export class AgentLoop {
  private modelClient: ModelClient
  private eventBus: EventBus
  private config: AgentLoopConfig
  private state: AgentState = 'idle'
  /** 独立的取消标志，因为 cancel() 可从外部异步调用，TS 控制流无法感知 */
  private cancelled = false
  private abortController: AbortController | null = null

  /** 对话上下文：累积所有消息用于下一次模型调用 */
  private context: ChatMessage[] = []

  /** 工具注册表 */
  private toolRegistry: ToolRegistry | null = null

  /** 工作区路径（传入后工具执行才有工作区边界） */
  private workingDir: string | null = null

  /** bash 工具的自定义 shell 路径（可选） */
  private shellPath: string | undefined = undefined

  /** bash 工具的 PATH 注入目录（可选） */
  private binDirs: string[] = []

  /** 运行模式（plan / default / auto） */
  private mode: Mode = 'default'

  /** checkpoint 管理器（可选，S6 引入） */
  private checkpointManager: CheckpointManager | null = null

  /** 权限决策引擎（可选，S7 引入） */
  private permissionManager: PermissionManager | null = null

  /** 会话级状态存储（透传给 todo_write 等需要写会话元数据的工具） */
  private sessionStore: SessionStore | null = null

  /** 当前会话 ID，与 sessionStore 配套 */
  private sessionId: string | null = null

  /** 等待用户确认的权限请求（requestId → { resolve, reject } 回调） */
  private pendingPermissions: Map<
    string,
    { resolve: (granted: boolean) => void; reject: (err: Error) => void }
  > = new Map()

  /** 最大工具调用轮数（可动态调整） */
  private maxToolRounds: number

  /** 缓存诊断跟踪器：检测 system prompt / 工具定义变化导致的缓存失效 */
  private cacheDiagnostics = new CacheDiagnostics()

  /** 截断管道：用于工具输出超限时进行结构化截断 */
  private truncationPipeline = createTruncationPipeline()

  /** 上下文溢出重试标志（防止同一轮无限循环） */
  private contextOverflowRetryAttempted = false
  /** 是否正在执行溢出压缩（用于守卫正常压缩逻辑） */
  private compressingForOverflow = false
  /** 缓存上次估算的 token 数，用于判断守卫 */
  private lastEstimatedTokens = 0
  /** 压缩层级计数 */
  private compactionLevel = 0

  /**
   * 重复失败熔断计数：signature(toolName + 参数) → 失败次数。
   * 用于检测模型对「完全相同的工具调用」反复触发并反复失败的死循环
   * （典型场景：edit 因 readState 键不一致一直报 "File has not been read yet"，
   * 模型 read→edit→失败→read 无限重试，最终把渲染进程拖垮 / OOM）。
   * 每条用户消息开始时清空。
   */
  private repeatedFailureCounts = new Map<string, number>()
  /** 同一签名工具调用累计失败达到该次数即熔断，停止本轮循环 */
  private static readonly REPEATED_FAILURE_LIMIT = 3

  constructor(
    modelClient: ModelClient,
    eventBus: EventBus,
    config?: AgentLoopConfig
  ) {
    this.modelClient = modelClient
    this.eventBus = eventBus
    this.config = {
      systemPrompt: config?.systemPrompt ?? '你是 Nova 的编程助手。',
      maxToolRounds: config?.maxToolRounds ?? 20,
      contextWindow: config?.contextWindow,
      supportsVision: config?.supportsVision ?? true,
      toolExecution: config?.toolExecution ?? 'parallel',
      maxParallelToolCalls: Math.max(1, config?.maxParallelToolCalls ?? 4),
      onCompaction: config?.onCompaction
    }
    this.maxToolRounds = this.config.maxToolRounds ?? 20

    if (this.config.systemPrompt) {
      this.context.push({
        role: 'system',
        content: this.config.systemPrompt
      })
    }
  }

  /**
   * 注入历史对话上下文（放在 system prompt 之后）
   * 用于每次 send-message 时从 session 恢复多轮历史
   */
  injectHistory(messages: ChatMessage[]): void {
    // 历史消息插入到 system prompt 之后
    // this.context[0] 是 system prompt（如果配置了的话），后续是历史
    this.context = [
      ...this.context,
      ...messages
    ]
  }

  /** 设置工具注册表 */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry
  }

  /** 设置工作区路径（工具执行时的边界目录） */
  setWorkingDir(dir: string): void {
    this.workingDir = dir
  }

  /**
   * 设置 bash 工具的执行环境（可选）。
   *
   * - shellPath：覆盖默认 Shell 发现
   * - binDirs：注入到 PATH 前面的目录列表
   *
   * 透传给 ToolContext，由 bash 工具读取。
   * 同时清空 bashTool.description 的懒缓存，让新 shellPath 生效。
   */
  setBashEnvironment(env: { shellPath?: string; binDirs?: string[] } = {}): void {
    this.shellPath = env.shellPath
    this.binDirs = env.binDirs ?? []
    if (env.shellPath) {
      // 动态 import 避免循环依赖（agent → tools → shellConfig 不会反向）
      import('../tools/bash').then((mod) => mod.invalidateBashDescriptionCache?.())
    }
  }

  /** 设置运行模式 */
  setMode(mode: Mode): void {
    this.mode = mode
  }

  /** 设置 checkpoint 管理器 */
  setCheckpointManager(manager: CheckpointManager): void {
    this.checkpointManager = manager
  }

  /** 设置权限决策引擎 */
  setPermissionManager(manager: PermissionManager): void {
    this.permissionManager = manager
  }

  /**
   * 设置会话上下文：把 SessionStore 与当前 sessionId 注入 AgentLoop，
   * 工具执行时由 toolBatchExecutor 透传到 ToolContext。
   * todo_write 等需要写会话元数据的工具会用到；其他工具不受影响。
   */
  setSessionContext(sessionStore: SessionStore, sessionId: string): void {
    this.sessionStore = sessionStore
    this.sessionId = sessionId
  }

  /** 动态调整最大工具调用轮数 */
  setMaxToolRounds(n: number): void {
    this.maxToolRounds = n
  }

  /** 获取当前状态 */
  getState(): AgentState {
    return this.state
  }

  /** 获取事件总线实例 */
  getEventBus(): EventBus {
    return this.eventBus
  }

  /** 获取当前对话上下文的快照 */
  getContext(): ChatMessage[] {
    return [...this.context]
  }

  /**
   * 发送用户消息并启动循环
   * 发射 message_start → (流式 text_delta / tool_call / tool_result) → message_end
   */
  async sendMessage(content: string | ContentBlock[]): Promise<void> {
    if (this.state === 'running') {
      this.eventBus.emit({ type: 'error', messageId: '', error: '当前正在执行中，请先取消' })
      return
    }

    const messageId = randomUUID()
    this.state = 'running'
    this.cancelled = false
    this.abortController = new AbortController()
    this.contextOverflowRetryAttempted = false
    this.repeatedFailureCounts.clear()

    // 将用户消息加入上下文，模式指令附加在尾部（不改前缀，缓存 Harness 核心）
    const modeInstruction = getModeInstruction(this.mode)
    let userContent: string | ContentBlock[]
    if (typeof content === 'string') {
      userContent = `${content}\n\n${modeInstruction}`
    } else {
      // ContentBlock[] 时，将模式指令追加为末尾 text block
      userContent = [...content, { type: 'text', text: modeInstruction }]
    }
    const userMessage: ChatMessage = {
      role: 'user',
      content: userContent
    }
    this.context.push(userMessage)

    // 开启 checkpoint 事务边界
    this.checkpointManager?.beginMessage(messageId)

    this.eventBus.emit({ type: 'message_start', messageId })

    try {
      let toolRound = 0

      while (toolRound < this.maxToolRounds) {
        if (this.cancelled) break

        let shouldRetryChat = false

        // 上下文压缩检查：跳过正在执行溢出压缩的轮次
        if (!this.compressingForOverflow) {
          const compactionThreshold = getCompactionThreshold(this.config.contextWindow ?? 200_000)
          // 2.4 守卫：使用上轮估算/API实际报告的 token 数和当前实时估算中的较大值作为判断依据，防范反复触发
          const currentTokens = estimateContextTokens(this.context)
          const tokensToCompare = Math.max(currentTokens, this.lastEstimatedTokens)
          if (shouldCompact(this.context, compactionThreshold, tokensToCompare)) {
            await this.runCompaction()
          }
        }

        // 获取工具定义（如果有 registry），始终传全部工具（缓存 Harness：工具集恒定）
        // 写操作约束完全由权限层（getBaseDecision / PermissionManager）控制
        const tools = this.toolRegistry?.getToolDefinitions()

        // 缓存诊断：记录本轮请求的基线（system prompt + 工具定义哈希）
        const systemPrompt = extractTextFromContent(
          this.context.find(m => m.role === 'system')?.content ?? ''
        )
        this.cacheDiagnostics.recordBaseline(systemPrompt, tools)

        // 调用模型，获取流式响应，传入 abort signal 实现真正的取消
        const stream = this.modelClient.chat(this.context, tools, {
          abortSignal: this.abortController?.signal
        })

        let assistantContent = ''
        const toolCalls: ChatToolCall[] = []
        let finishReason = ''

        for await (const event of stream) {
          if (this.cancelled) break

          switch (event.type) {
            case 'thinking_delta':
              this.eventBus.emit({ type: 'thinking_delta', messageId, delta: event.delta })
              break

            case 'text_delta':
              assistantContent += event.delta
              this.eventBus.emit({ type: 'text_delta', messageId, delta: event.delta })
              break

            case 'tool_call_start': {
              this.eventBus.emit({
                type: 'tool_call_start',
                messageId,
                toolCallId: event.toolCallId,
                toolName: event.toolName
              })
              break
            }

            case 'tool_call_delta': {
              this.eventBus.emit({
                type: 'tool_call_delta',
                messageId,
                toolCallId: event.toolCallId,
                argumentsDelta: event.argumentsDelta
              })
              break
            }

            case 'tool_call': {
              toolCalls.push(event.toolCall)
              this.eventBus.emit({
                type: 'tool_call',
                messageId,
                toolCallId: event.toolCall.id,
                toolName: event.toolCall.name,
                args: JSON.parse(event.toolCall.arguments || '{}')
              })
              break
            }

            case 'cancelled':
              // 模型请求被取消，跳出循环进入 cancelled 结束态
              this.cancelled = true
              break

            case 'context_overflow': {
              if (this.contextOverflowRetryAttempted) {
                this.eventBus.emit({ type: 'error', messageId, error: event.rawError })
                this.state = 'error'
                return
              }
              this.contextOverflowRetryAttempted = true

              const standardOk = await this.runOverflowCompaction('standard')
              if (standardOk) {
                shouldRetryChat = true
                break
              }

              const aggressiveOk = await this.runOverflowCompaction('aggressive')
              if (aggressiveOk) {
                shouldRetryChat = true
                break
              }

              this.eventBus.emit({ type: 'error', messageId, error: event.rawError })
              this.state = 'error'
              return
            }

            case 'error':
              this.eventBus.emit({ type: 'error', messageId, error: event.error })
              this.state = 'error'
              return

            case 'usage':
              this.eventBus.emit({ type: 'usage', messageId, usage: event.usage })
              // 缓存诊断：检查 cache_read_tokens 是否显著下降
              {
                const diag = this.cacheDiagnostics.checkResponse(
                  event.usage.cachedTokens,
                  extractTextFromContent(
                    this.context.find(m => m.role === 'system')?.content ?? ''
                  ),
                  this.toolRegistry?.getToolDefinitions()
                )
                if (diag.cacheBreakDetected) {
                  this.eventBus.emit({ type: 'cache_diagnostic', messageId, diagnostic: diag })
                }
              }
              break

            case 'message_end':
              finishReason = event.finishReason
              break
          }
        }

        if (this.cancelled) break

        if (shouldRetryChat) {
          continue
        }

        // 将 assistant 回复（含 tool_calls）加入上下文
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: assistantContent
        }
        if (toolCalls.length > 0) {
          assistantMsg.toolCalls = toolCalls
        }
        this.context.push(assistantMsg)

        // 每次成功调用模型后更新估算 token 计数
        this.lastEstimatedTokens = estimateContextTokens(this.context)

        // 如果模型没有调用工具，本轮结束
        if (toolCalls.length === 0 || finishReason !== 'tool_calls') {
          break
        }

        // 执行所有工具调用，将结果加入上下文
        toolRound++
        const batchResult = await executeToolBatch({
          toolCalls,
          messageId,
          toolRegistry: this.toolRegistry,
          workingDir: this.workingDir ?? process.cwd(),
          mode: this.mode,
          shellPath: this.shellPath,
          binDirs: this.binDirs,
          supportsVision: this.config.supportsVision ?? true,
          checkpointManager: this.checkpointManager,
          abortSignal: this.abortController?.signal,
          checkPermission: (toolName, args, currentMessageId) =>
            this.checkPermission(toolName, args, currentMessageId),
          emit: (event) => this.eventBus.emit(event),
          applyTruncation: (output, maxSize) => this.applyTruncation(output, maxSize),
          maxParallelToolCalls: this.config.maxParallelToolCalls ?? 4,
          toolExecution: this.config.toolExecution ?? 'parallel',
          sessionStore: this.sessionStore,
          sessionId: this.sessionId,
          eventBus: this.eventBus
        })

        if (!batchResult.aborted && !this.cancelled && !this.abortController?.signal.aborted) {
          for (const outcome of batchResult.outcomes) {
            if (outcome.skippedByAbort) continue
            this.context.push({
              role: 'tool',
              content: toToolContent(outcome.resultText, outcome.resultImages),
              toolCallId: outcome.toolCall.id
            })
          }
        }

        if (batchResult.aborted || this.cancelled || this.abortController?.signal.aborted) {
          this.cancelled = true
          break
        }

        // 熔断：检测对同一工具调用（名称 + 参数完全一致）的重复失败。
        // 命中后停止本轮循环，避免模型在无效调用上空转烧光 maxToolRounds，
        // 同时把海量流式事件灌向渲染进程导致卡顿 / OOM 白屏。
        const stuckTool = this.trackRepeatedFailures(batchResult.outcomes)
        if (stuckTool) {
          const notice =
            `\n\n[已自动中断] 检测到对「${stuckTool}」的相同调用连续失败 ` +
            `${AgentLoop.REPEATED_FAILURE_LIMIT} 次，已停止本轮以避免无效循环。` +
            `请查看上方的工具错误信息后再调整指令。`
          // 通过 text_delta 下发：renderer 追加展示，累积器并入持久化内容，口径一致
          this.eventBus.emit({ type: 'text_delta', messageId, delta: notice })
          break
        }

        // 继续下一轮模型调用（带着工具结果）
      }
    } catch (err) {
      if (!this.cancelled) {
        this.eventBus.emit({ type: 'error', messageId, error: (err as Error).message })
        this.state = 'error'
        return
      }
    }

    if (this.state === 'running') {
      this.state = 'idle'
    }

    // 结束 checkpoint 事务边界
    this.checkpointManager?.endMessage()

    // Phase 3：取消场景下 message-end 携带 interrupted=true，便于前端区分
    // 正常完成与 cancel 中断（前端据此标记消息 + 决定是否重试/排队等）。
    // 注意：this.cancelled 由 cancel() 设置，状态机此时可能为 'cancelled' 或 'idle'，
    // 因此判定 cancel 的根因应看 this.cancelled（独立的 boolean 标志），
    // 不依赖 this.state 的字面值。
    // 仅在 interrupted=true 时携带字段，与设计文档"新增 interrupted 字段"语义一致。
    this.eventBus.emit({
      type: 'message_end',
      messageId,
      ...(this.cancelled ? { interrupted: true } : {})
    })
  }

  /**
   * 执行上下文压缩
   * 将旧消息发给模型生成摘要，然后用 [system, 摘要, 最近 N 条] 重建上下文。
   * 压缩调用本身复用现有缓存前缀（只追加压缩指令到尾部）。
   */
  private async runCompaction(): Promise<void> {
    const systemMsg = this.context.find(m => m.role === 'system')
    const systemPrompt = extractTextFromContent(systemMsg?.content ?? '')

    const { oldMessages, recentMessages } = splitForCompaction(this.context, MIN_RECENT_MESSAGES)
    if (oldMessages.length === 0) return

    // 构建压缩上下文：旧消息 + 压缩指令（追加到尾部，不改前缀）
    // 如果上下文末尾是 user 消息，先插入一条 assistant 占位避免连续 user（Anthropic 严格模式会拒绝）
    const lastMsg = this.context[this.context.length - 1]
    const needsAssistantBridge = lastMsg?.role === 'user'
    const compactionContext: ChatMessage[] = [
      ...this.context,
      ...(needsAssistantBridge
        ? [{ role: 'assistant' as const, content: '好的，我来总结之前的对话。' }]
        : []),
      // 压缩指令标记为 internal：不标记缓存，发送给 API 前剥离此字段
      { role: 'user' as const, content: buildCompactionPrompt(recentMessages.length), internal: true }
    ]

    // 调用模型生成摘要（非流式收集）
    let summary = ''
    try {
      const stream = this.modelClient.chat(compactionContext, undefined, {
        abortSignal: this.abortController?.signal
      })
      for await (const event of stream) {
        if (this.cancelled) return
        if (event.type === 'text_delta') {
          summary += event.delta
        }
      }
    } catch {
      // 压缩失败不影响主流程，跳过本次压缩
      return
    }

    if (!summary.trim()) return

    // 重建上下文
    this.context = rebuildWithCompression(systemPrompt, summary.trim(), recentMessages)
    this.compactionLevel++
    this.lastEstimatedTokens = estimateContextTokens(this.context)

    // 缓存诊断：压缩后上下文完全改变，重置基线避免误报
    this.cacheDiagnostics.resetBaseline(
      extractTextFromContent(
        this.context.find(m => m.role === 'system')?.content ?? ''
      ),
      this.toolRegistry?.getToolDefinitions()
    )

    // 通知外部持久化压缩态（agentHandler 写回 SessionStore）
    this.config.onCompaction?.(this.context)
  }

  /** 对工具输出应用截断，超限时用三明治模式拼装提示 */
  private applyTruncation(output: string, maxSize: number): string {
    const pipeline = createTruncationPipeline({ maxByteSize: maxSize })
    const result = pipeline.apply(output)

    if (!result.truncated || !result.meta) {
      return output
    }

    const { shown, total, limit, truncatedAt } = result.meta
    const topHint = `[系统提示] 以下为截断结果（显示 ${shown}/${total ?? '?'}，触发 ${truncatedAt} 上限 ${limit}）\n`
    const bottomAction = this.buildBottomActions(truncatedAt, shown, total, limit)

    return topHint + result.output + '\n' + bottomAction
  }

  /** 按截断层生成可执行的底部建议 */
  private buildBottomActions(
    stage: TruncationStage,
    shown: number,
    total: number | undefined,
    limit: number
  ): string {
    switch (stage) {
      case 'match_count':
        return `[系统提示] 结果已截断：显示 ${shown}/${total ?? '?'} 条（匹配数上限 ${limit}）。请执行以下之一：\n1. 添加 glob: "*.ts" 过滤文件类型\n2. 使用 output_mode: "files_with_matches" 先确认涉及哪些文件\n3. 缩小 path 到具体子目录\n4. 使用 head_limit + offset 分批获取下一批`

      case 'byte_size':
        return `[系统提示] 结果已截断：输出 ${shown}KB/${total ?? '?'}KB（字节上限 ${limit}KB）。请执行以下之一：\n1. 使用 output_mode: "files_with_matches" 仅获取文件路径\n2. 缩小 path 到具体子目录\n3. 添加 glob 过滤减少匹配文件数`

      case 'line_length':
        return `[系统提示] 部分行已截断：行长度超 ${limit} 字符上限，超出部分以 ...[截断] 标记。\n对该文件使用 read 工具获取完整内容。`
    }
  }

  /**
   * 跟踪并检测重复失败的工具调用。
   *
   * 对每个非中断的工具结果计算签名（工具名 + 序列化参数）：
   * - 失败结果（"工具执行失败" / "权限拒绝:"）累加该签名的失败计数；
   * - 成功结果清零该签名计数（说明该调用已不再卡住）。
   *
   * 当任一签名累计失败次数达到 REPEATED_FAILURE_LIMIT，返回对应工具名表示需要熔断；
   * 否则返回 null。只有「参数完全相同」的调用才会累加，因此模型在迭代修复
   * （每次参数不同）时不会被误伤。
   *
   * @returns 触发熔断的工具名；未触发返回 null
   */
  private trackRepeatedFailures(
    outcomes: Array<{ toolCall: ChatToolCall; args: Record<string, unknown>; resultText: string; failed?: boolean; skippedByAbort?: boolean }>
  ): string | null {
    for (const outcome of outcomes) {
      if (outcome.skippedByAbort) continue

      // 用结构化的 failed 标记判定失败，而非从渲染后的中文 resultText 前缀反推，
      // 避免文案本地化 / 调整后熔断器静默失效，也能覆盖"未注册工具"等不以
      // "工具执行失败" 开头的错误结果。
      const failed = outcome.failed === true
      // 参数可能含大体量内容（如 write 的 content），签名做长度上限保护，
      // 仅用于「是否同一调用」的判定，过长时截断不影响判等的稳定性。
      let argsKey: string
      try {
        argsKey = JSON.stringify(outcome.args)
      } catch {
        argsKey = String(outcome.args)
      }
      const signature = `${outcome.toolCall.name}:${argsKey.slice(0, 4096)}`

      if (failed) {
        const next = (this.repeatedFailureCounts.get(signature) ?? 0) + 1
        this.repeatedFailureCounts.set(signature, next)
        if (next >= AgentLoop.REPEATED_FAILURE_LIMIT) {
          return outcome.toolCall.name
        }
      } else {
        this.repeatedFailureCounts.delete(signature)
      }
    }
    return null
  }

  /** 取消当前执行 */
  cancel(): void {
    if (this.state === 'running') {
      this.cancelled = true
      this.state = 'cancelled'
      this.abortController?.abort()
      // 拒绝所有等待中的权限请求（用 PermissionAbortedError 而非 resolve(false)，
      // 这样 checkPermission 不会把它当成"用户拒绝"生成权限拒绝 tool_result）
      for (const [id, entry] of this.pendingPermissions) {
        entry.reject(new PermissionAbortedError())
        this.pendingPermissions.delete(id)
      }
    }
  }

  /**
   * 权限检查入口
   * 返回：
   * - { allowed: true }：可执行
   * - { allowed: false, reason }：用户主动拒绝或规则拒绝，需把"权限拒绝: {reason}"作为 tool_result 回传模型
   * - { aborted: true }：流程被 cancel 打断，调用方应跳过该工具的 tool_result 与 context 注入
   */
  private async checkPermission(
    toolName: string,
    args: Record<string, unknown>,
    messageId: string
  ): Promise<{ allowed: boolean; reason: string; aborted?: boolean }> {
    // 没有 PermissionManager 时退化为简单 plan 模式检查
    if (!this.permissionManager) {
      if (this.mode === 'plan' && WRITE_TOOLS.has(toolName)) {
        return {
          allowed: false,
          reason: `当前为 plan 模式，"${toolName}" 工具不可用。请切换到 default 或 auto 模式后再执行写入操作。`
        }
      }
      return { allowed: true, reason: '' }
    }

    const result = this.permissionManager.check({ toolName, args }, this.mode)

    if (result.decision === 'allow') {
      return { allowed: true, reason: '' }
    }

    if (result.decision === 'deny') {
      return { allowed: false, reason: result.reason }
    }

    // decision === 'ask'：发射 permission_request 事件，等待用户决策
    const requestId = randomUUID()
    const permissionResponse = this.waitForPermissionResponse(requestId)

    this.eventBus.emit({
      type: 'permission_request',
      messageId,
      requestId,
      toolName,
      args,
      riskLevel: result.riskLevel,
      reason: result.reason
    })

    try {
      const granted = await permissionResponse
      if (!granted) {
        return { allowed: false, reason: `用户拒绝了 "${toolName}" 工具的执行请求` }
      }
      return { allowed: true, reason: '' }
    } catch (err) {
      if (err instanceof PermissionAbortedError) {
        return { allowed: false, reason: '', aborted: true }
      }
      throw err
    }
  }

  /** 等待用户对权限请求的响应；cancel 时会以 PermissionAbortedError reject */
  private waitForPermissionResponse(requestId: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.pendingPermissions.set(requestId, { resolve, reject })
    })
  }

  /**
   * 回应权限请求（由 IPC handler 调用）
   * @param requestId 权限请求 ID
   * @param granted 用户是否允许
   */
  respondPermission(requestId: string, granted: boolean): void {
    const entry = this.pendingPermissions.get(requestId)
    if (entry) {
      this.pendingPermissions.delete(requestId)
      entry.resolve(granted)
    }
  }

  /**
   * 上下文溢出紧急压缩
   * 参考 OpenClacky llm_caller.rb perform_context_overflow_compression (L426-517)
   *
   * @param mode 'standard' (pull_back=1, 保缓存) 或 'aggressive' (pull_back≈一半, 保生存)
   * @returns true 表示压缩成功，应重试原始请求；false 表示压缩失败或不可用
   */
  private async runOverflowCompaction(mode: 'standard' | 'aggressive'): Promise<boolean> {
    const pullBack = mode === 'aggressive'
      ? Math.max(4, Math.min(
          Math.floor(this.context.length / 2),
          this.context.length - 2,
          64))
      : 1

    this.compressingForOverflow = true
    let compressionPointIndex = -1
    const pulledBackMessages: ChatMessage[] = []

    const rollbackAndRestore = () => {
      if (compressionPointIndex >= 0) {
        this.context = rollbackBefore(this.context, compressionPointIndex)
      }
      pulledBackMessages.forEach(m => this.context.push(m))
    }

    try {
      // 1. 从 this.context 末尾弹出 pullBack 条消息
      for (let i = 0; i < pullBack && this.context.length > 2; i++) {
        const popped = this.context.pop()!
        if (popped.role !== 'system') {
          pulledBackMessages.unshift(popped)
        } else {
          this.context.push(popped) // 不弹 system，放回
          break
        }
      }

      // 2. 强制触发压缩
      const systemMsg = this.context.find(m => m.role === 'system')
      const systemPrompt = extractTextFromContent(systemMsg?.content ?? '')
      const { oldMessages, recentMessages } = splitForCompaction(this.context, MIN_RECENT_MESSAGES)

      if (oldMessages.length === 0) {
        // [修复] 当 oldMessages 为空早退时，将刚才弹出的 pulledBackMessages 推回，避免消息丢失
        pulledBackMessages.forEach(m => this.context.push(m))
        return false
      }

      // 3. 构建压缩上下文，追加到 this.context
      const lastMsg = this.context[this.context.length - 1]
      const needsAssistantBridge = lastMsg?.role === 'user'
      compressionPointIndex = this.context.length

      const compactionMessages: ChatMessage[] = [
        ...(needsAssistantBridge
          ? [{ role: 'assistant' as const, content: '好的，我来总结之前的对话。' }]
          : []),
        { role: 'user' as const, content: buildCompactionPrompt(recentMessages.length), internal: true }
      ]
      this.context.push(...compactionMessages)

      // 4. 调用模型获取摘要
      let summary = ''
      const stream = this.modelClient.chat(this.context, undefined, {
        abortSignal: this.abortController?.signal
      })
      for await (const event of stream) {
        if (this.cancelled) {
          rollbackAndRestore()
          return false
        }
        if (event.type === 'text_delta') {
          summary += event.delta
        }
        if (event.type === 'context_overflow') {
          // 压缩调用本身也溢出了，回滚后返回 false 让上层升级到 aggressive
          rollbackAndRestore()
          return false
        }
        if (event.type === 'error') {
          rollbackAndRestore()
          return false
        }
      }

      if (!summary.trim()) {
        rollbackAndRestore()
        return false
      }

      // 5. 成功：重建上下文 + 追加 pulledBack
      this.context = rebuildWithCompression(systemPrompt, summary.trim(), recentMessages, pulledBackMessages)
      this.compactionLevel++

      // 重置 token 估算，防止下轮立即重新触发压缩
      this.lastEstimatedTokens = estimateContextTokens(this.context)

      // 重置缓存诊断基线
      this.cacheDiagnostics.resetBaseline(
        extractTextFromContent(this.context.find(m => m.role === 'system')?.content ?? ''),
        this.toolRegistry?.getToolDefinitions()
      )

      // 通知外部持久化
      this.config.onCompaction?.(this.context)

      return true
    } catch {
      rollbackAndRestore()
      return false
    } finally {
      this.compressingForOverflow = false
    }
  }

  /** 清空对话上下文 */
  reset(): void {
    this.context = this.config.systemPrompt
      ? [{ role: 'system', content: this.config.systemPrompt }]
      : []
    this.state = 'idle'
    this.cancelled = false
    this.abortController = null
  }
}
