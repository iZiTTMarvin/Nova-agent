/**
 * Mock ModelClient — 测试辅助工具
 * 产出预设的 ChatEvent 序列，用于验证 AgentLoop 逻辑而不依赖真实模型 API
 */
import type { ChatMessage, ChatEvent, ToolDefinition, ModelClientConfig } from '../../runtime/model/types'
import type { ModelClient, ChatOptions } from '../../runtime/model/ModelClient'

export interface MockResponse {
  events: ChatEvent[]
  handoff?: boolean
}

export class MockModelClient implements ModelClient {
  private responses: MockResponse[] = []
  private callIndex = 0
  private config: ModelClientConfig = { baseUrl: '', apiKey: '', modelId: '' }

  /** 预设下一次 chat 调用的响应 */
  addResponse(response: MockResponse): this {
    this.responses.push(response)
    return this
  }

  /** 压缩成对调用：先 stub 后 state；省略 stub 时两者使用同一响应 */
  addCompactionPair(state: MockResponse, stub: MockResponse = state): this {
    return this.addResponse(stub).addResponse(state)
  }

  /** 生命周期 fixture 的有效结构化响应；协议拒绝测试仍传原始 events。 */
  addHandoffPair(state: MockResponse, stub: MockResponse = state): this {
    return this.addResponse(stub).addResponse({ ...state, handoff: true })
  }

  /** 获取所有历史调用 */
  getCalls(): { messages: ChatMessage[]; tools?: ToolDefinition[]; options?: ChatOptions }[] {
    return this.calls
  }

  private calls: { messages: ChatMessage[]; tools?: ToolDefinition[]; options?: ChatOptions }[] = []

  async *chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions
  ): AsyncIterable<ChatEvent> {
    this.calls.push({ messages: [...messages], tools: tools ? [...tools] : undefined, options })

    const response = this.responses[this.callIndex] ?? { events: [] }
    this.callIndex++

    if (response.handoff && response.events.some(event => event.type === 'text_delta')) {
      const goal = response.events.filter(event => event.type === 'text_delta').map(event => event.delta).join('').trim()
      const instruction = messages.at(-1)?.content
      const facts: unknown = typeof instruction === 'string' ? JSON.parse(instruction.slice(instruction.lastIndexOf('\n') + 1)) : []
      yield { type: 'text_delta', delta: JSON.stringify({ schemaVersion: 1, goal, nextActions: '继续任务', keyContext: '(none)', progress: '(none)', decisions: '(none)', facts }) }
      for (const event of response.events) if (event.type !== 'text_delta') yield event
      return
    }

    for (const event of response.events) {
      yield event
    }
  }

  updateConfig(config: ModelClientConfig): void {
    this.config = config
  }
}
