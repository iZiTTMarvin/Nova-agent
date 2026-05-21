/**
 * Mock ModelClient — 测试辅助工具
 * 产出预设的 ChatEvent 序列，用于验证 AgentLoop 逻辑而不依赖真实模型 API
 */
import type { ChatMessage, ChatEvent, ToolDefinition } from '../../runtime/model/types'
import type { ModelClient } from '../../runtime/model/ModelClient'
import type { ModelClientConfig } from '../../runtime/model/types'

export interface MockResponse {
  events: ChatEvent[]
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

  /** 获取所有历史调用 */
  getCalls(): { messages: ChatMessage[]; tools?: ToolDefinition[] }[] {
    return this.calls
  }

  private calls: { messages: ChatMessage[]; tools?: ToolDefinition[] }[] = []

  async *chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[]
  ): AsyncIterable<ChatEvent> {
    this.calls.push({ messages: [...messages], tools: tools ? [...tools] : undefined })

    const response = this.responses[this.callIndex] ?? { events: [] }
    this.callIndex++

    for (const event of response.events) {
      yield event
    }
  }

  updateConfig(config: ModelClientConfig): void {
    this.config = config
  }
}
