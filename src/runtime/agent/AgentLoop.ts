/**
 * AgentLoop — 核心消息-模型-工具循环
 * 接收用户消息，组织上下文，调用模型，处理工具调用，通过 EventBus 向外发射流式事件
 *
 * S3 阶段：纯文本对话循环（消息 → 模型 → 响应）
 * S4 阶段：加入工具调度（tool_call → 执行 → 结果回模型 → 重复）
 */
import type { ModelClient } from '../model/ModelClient'
import type { ChatMessage, ChatToolCall } from '../model/types'
import type { AgentState, AgentLoopConfig } from './types'
import type { ToolRegistry } from '../tools/ToolRegistry'
import { EventBus } from './EventBus'
import { randomUUID } from 'crypto'

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
      systemPrompt: config?.systemPrompt ?? '你是一个编程助手。',
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

  /** 设置工具注册表 */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry
  }

  /** 设置工作区路径（工具执行时的边界目录） */
  setWorkingDir(dir: string): void {
    this.workingDir = dir
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

    this.eventBus.emit({ type: 'message_start', messageId })

    try {
      let toolRound = 0

      while (toolRound < this.maxToolRounds) {
        if (this.cancelled) break

        // 获取工具定义（如果有 registry）
        const tools = this.toolRegistry?.getToolDefinitions()

        // 调用模型，获取流式响应
        const stream = this.modelClient.chat(this.context, tools)

        let assistantContent = ''
        const toolCalls: ChatToolCall[] = []
        let finishReason = ''

        for await (const event of stream) {
          if (this.cancelled) break

          switch (event.type) {
            case 'text_delta':
              assistantContent += event.delta
              this.eventBus.emit({ type: 'text_delta', messageId, delta: event.delta })
              break

            case 'tool_call':
              toolCalls.push(event.toolCall)
              this.eventBus.emit({
                type: 'tool_call',
                messageId,
                toolName: event.toolCall.name,
                args: JSON.parse(event.toolCall.arguments || '{}')
              })
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

          if (this.toolRegistry) {
            const toolResult = await this.toolRegistry.execute(tc.name, args, {
              workingDir: this.workingDir ?? process.cwd()
            })
            result = toolResult.success
              ? toolResult.output
              : `工具执行失败: ${toolResult.error}`
          } else {
            result = `工具 "${tc.name}" 不可用：未注册工具`
          }

          this.eventBus.emit({
            type: 'tool_result',
            messageId,
            toolName: tc.name,
            result
          })

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
