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
import type { ChatMessage, ChatToolCall } from '../model/types'
import type { AgentState, AgentLoopConfig } from './types'
import type { ToolRegistry } from '../tools/ToolRegistry'
import type { CheckpointManager } from '../checkpoints/CheckpointManager'
import type { PermissionManager } from '../permissions/PermissionManager'
import type { Mode } from '../../shared/session/types'
import { isToolVisibleInMode } from '../../shared/session/toolVisibility'
import { EventBus } from './EventBus'
import { getBaseDecision } from '../permissions/rules'
import { randomUUID } from 'crypto'

/** 写入类工具名称集合，plan 模式下会被拒绝 */
const WRITE_TOOLS = new Set(['edit', 'write', 'bash'])

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

  /** 工具注册表（可选，S4 引入） */
  private toolRegistry: ToolRegistry | null = null

  /** 工作区路径（可选，传入后工具执行才有工作区边界） */
  private workingDir: string | null = null

  /** 运行模式（plan / default / auto） */
  private mode: Mode = 'default'

  /** checkpoint 管理器（可选，S6 引入） */
  private checkpointManager: CheckpointManager | null = null

  /** 权限决策引擎（可选，S7 引入） */
  private permissionManager: PermissionManager | null = null

  /** 等待用户确认的权限请求（requestId → resolve 回调） */
  private pendingPermissions: Map<string, (granted: boolean) => void> = new Map()

  /** 最大工具调用轮数（可动态调整） */
  private maxToolRounds: number

  constructor(
    modelClient: ModelClient,
    eventBus: EventBus,
    config?: AgentLoopConfig
  ) {
    this.modelClient = modelClient
    this.eventBus = eventBus
    this.config = {
      systemPrompt: config?.systemPrompt ?? '你是 Nova 的编程助手。',
      maxToolRounds: config?.maxToolRounds ?? 20
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

    // 将用户消息加入上下文
    const userMessage: ChatMessage = { role: 'user', content }
    this.context.push(userMessage)

    // 开启 checkpoint 事务边界
    this.checkpointManager?.beginMessage(messageId)

    this.eventBus.emit({ type: 'message_start', messageId })

    try {
      let toolRound = 0

      while (toolRound < this.maxToolRounds) {
        if (this.cancelled) break

        // 获取工具定义（如果有 registry），按 mode 过滤被禁止的工具
        const allTools = this.toolRegistry?.getToolDefinitions()
        const tools = allTools?.filter(t => isToolVisibleInMode(this.mode, t.name))

        // 调用模型，获取流式响应，传入 abort signal 实现真正的取消
        const stream = this.modelClient.chat(this.context, tools, {
          abortSignal: this.abortController?.signal
        })

        let assistantContent = ''
        const toolCalls: ChatToolCall[] = []
        const hiddenToolCallIds = new Set<string>()
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

            case 'tool_call': {
              const hiddenByMode = !isToolVisibleInMode(this.mode, event.toolCall.name)
              toolCalls.push(event.toolCall)

              // 模式策略禁止的工具调用仍要回传模型结果，但不进入 UI 事件流
              if (hiddenByMode) {
                hiddenToolCallIds.add(event.toolCall.id)
                break
              }

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
          let result: string
          const hiddenByMode = hiddenToolCallIds.has(tc.id)

          // 权限检查（S7：用 PermissionManager 替代原来的硬编码 plan 检查）
          const permissionResult = await this.checkPermission(tc.name, args, messageId)

          if (!permissionResult.allowed) {
            result = `权限拒绝: ${permissionResult.reason}`
          } else if (this.toolRegistry) {
            const toolResult = await this.toolRegistry.execute(tc.name, args, {
              workingDir: this.workingDir ?? process.cwd(),
              ...(this.checkpointManager ? { checkpointManager: this.checkpointManager } : {}),
              ...(this.abortController ? { abortSignal: this.abortController.signal } : {})
            })
            result = toolResult.success
              ? toolResult.output
              : `工具执行失败: ${toolResult.error}`
          } else {
            result = `工具 "${tc.name}" 不可用：未注册工具`
          }

          if (!hiddenByMode) {
            this.eventBus.emit({
              type: 'tool_result',
              messageId,
              toolCallId: tc.id,
              toolName: tc.name,
              result
            })
          }

          this.context.push({
            role: 'tool',
            content: result,
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

  /** 安全解析 JSON 参数 */
  private parseArgs(argsStr: string): Record<string, unknown> {
    try {
      return JSON.parse(argsStr || '{}')
    } catch {
      return {}
    }
  }

  /** 取消当前执行 */
  cancel(): void {
    if (this.state === 'running') {
      this.cancelled = true
      this.state = 'cancelled'
      this.abortController?.abort()
      // 拒绝所有等待中的权限请求
      for (const [id, resolve] of this.pendingPermissions) {
        resolve(false)
        this.pendingPermissions.delete(id)
      }
    }
  }

  /**
   * 权限检查入口
   * 返回是否允许执行，如果不允许则附带拒绝原因
   */
  private async checkPermission(
    toolName: string,
    args: Record<string, unknown>,
    messageId: string
  ): Promise<{ allowed: boolean; reason: string }> {
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

    const granted = await permissionResponse
    if (!granted) {
      return { allowed: false, reason: `用户拒绝了 "${toolName}" 工具的执行请求` }
    }
    return { allowed: true, reason: '' }
  }

  /** 等待用户对权限请求的响应 */
  private waitForPermissionResponse(requestId: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, resolve)
    })
  }

  /**
   * 回应权限请求（由 IPC handler 调用）
   * @param requestId 权限请求 ID
   * @param granted 用户是否允许
   */
  respondPermission(requestId: string, granted: boolean): void {
    const resolve = this.pendingPermissions.get(requestId)
    if (resolve) {
      this.pendingPermissions.delete(requestId)
      resolve(granted)
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
