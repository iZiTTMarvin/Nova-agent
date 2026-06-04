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
import type { Mode } from '../../shared/session/types'
import type { TruncationStage } from '../tools/grep-types'
import { createTruncationPipeline } from '../tools/TruncationPipeline'
import { EventBus } from './EventBus'
import { getModeInstruction } from './modeInstruction'
import { shouldCompact, splitForCompaction, buildCompactionPrompt, rebuildWithCompression, MIN_RECENT_MESSAGES, getCompactionThreshold } from './compaction'
import { CacheDiagnostics } from '../model/cacheDiagnostics'
import { randomUUID } from 'crypto'

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

  /** 运行模式（plan / default / auto） */
  private mode: Mode = 'default'

  /** checkpoint 管理器（可选，S6 引入） */
  private checkpointManager: CheckpointManager | null = null

  /** 权限决策引擎（可选，S7 引入） */
  private permissionManager: PermissionManager | null = null

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
      supportsVision: config?.supportsVision ?? true
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
  async sendMessage(content: string): Promise<void> {
    if (this.state === 'running') {
      this.eventBus.emit({ type: 'error', messageId: '', error: '当前正在执行中，请先取消' })
      return
    }

    const messageId = randomUUID()
    this.state = 'running'
    this.cancelled = false
    this.abortController = new AbortController()

    // 将用户消息加入上下文，模式指令附加在尾部（不改前缀，缓存 Harness 核心）
    const modeInstruction = getModeInstruction(this.mode)
    const userMessage: ChatMessage = {
      role: 'user',
      content: `${content}\n\n${modeInstruction}`
    }
    this.context.push(userMessage)

    // 开启 checkpoint 事务边界
    this.checkpointManager?.beginMessage(messageId)

    this.eventBus.emit({ type: 'message_start', messageId })

    try {
      let toolRound = 0

      while (toolRound < this.maxToolRounds) {
        if (this.cancelled) break

        // 上下文压缩检查（缓存 Harness：先插入再压缩）
        const compactionThreshold = getCompactionThreshold(this.config.contextWindow ?? 200_000)
        if (shouldCompact(this.context, compactionThreshold)) {
          await this.runCompaction()
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

        // 将 assistant 回复（含 tool_calls）加入上下文
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: assistantContent
        }
        if (toolCalls.length > 0) {
          assistantMsg.toolCalls = toolCalls
        }
        this.context.push(assistantMsg)

        // 如果模型没有调用工具，本轮结束
        if (toolCalls.length === 0 || finishReason !== 'tool_calls') {
          break
        }

        // 执行所有工具调用，将结果加入上下文
        toolRound++
        for (const tc of toolCalls) {
          if (this.cancelled) break

          const args = this.parseArgs(tc.arguments)
          let resultText: string
          let resultImages: import('../tools/types').ImageContent[] | undefined

          // 权限检查（用 PermissionManager 做 allow/deny/ask 三态决策）
          const permissionResult = await this.checkPermission(tc.name, args, messageId)

          // 权限请求被 cancel 中断：跳过 tool_result 与 context 注入
          if (permissionResult.aborted) {
            break
          }

          if (!permissionResult.allowed) {
            resultText = `权限拒绝: ${permissionResult.reason}`
          } else if (this.toolRegistry) {
            const toolResult = await this.toolRegistry.execute(tc.name, args, {
              workingDir: this.workingDir ?? process.cwd(),
              ...(this.checkpointManager ? { checkpointManager: this.checkpointManager } : {}),
              ...(this.abortController ? { abortSignal: this.abortController.signal } : {}),
              supportsVision: this.config.supportsVision
            })
            if (toolResult.success) {
              const tool = this.toolRegistry.getTool(tc.name)
              const maxSize = tool?.maxResultSizeChars
              resultText = maxSize != null
                ? this.applyTruncation(toolResult.output, maxSize)
                : toolResult.output
              resultImages = toolResult.images
            } else {
              resultText = `工具执行失败: ${toolResult.error}`
            }
          } else {
            resultText = `工具 "${tc.name}" 不可用：未注册工具`
          }

          this.eventBus.emit({
            type: 'tool_result',
            messageId,
            toolCallId: tc.id,
            toolName: tc.name,
            result: resultText
          })

          // 构建 tool 消息内容：纯文本用 string，带图片用 ContentBlock 数组
          const toolContent: string | ContentBlock[] = resultImages?.length
            ? [
                { type: 'text', text: resultText },
                ...resultImages.map(img => ({
                  type: 'image_url' as const,
                  image_url: {
                    url: `data:${img.mimeType};base64,${img.data}`,
                  },
                })),
              ]
            : resultText

          this.context.push({
            role: 'tool',
            content: toolContent,
            toolCallId: tc.id
          })
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

    this.eventBus.emit({ type: 'message_end', messageId })
  }

  /**
   * 执行上下文压缩
   * 将旧消息发给模型生成摘要，然后用 [system, 摘要, 最近 N 条] 重建上下文。
   * 压缩调用本身复用现有缓存前缀（只追加压缩指令到尾部）。
   */
  private async runCompaction(): Promise<void> {
    const systemMsg = this.context.find(m => m.role === 'system')
    const systemPrompt = extractTextFromContent(systemMsg?.content ?? '')

    const [oldMessages, recentMessages] = splitForCompaction(this.context, MIN_RECENT_MESSAGES)
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

  /** 安全解析 JSON 参数 */
  private parseArgs(argsStr: string): Record<string, unknown> {
    try {
      return JSON.parse(argsStr || '{}')
    } catch {
      return {}
    }
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
