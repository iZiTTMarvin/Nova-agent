/**
 * OpenAI-compatible 模型客户端
 * 通过 fetch 调用兼容 OpenAI Chat Completions API 的模型服务
 * 支持 SSE 流式响应，纯 Node.js 实现，不依赖 Electron
 */
import type { ChatMessage, ChatEvent, ToolDefinition, ModelClientConfig, ChatToolCall } from './types'
import type { ModelClient } from './ModelClient'
import { ThinkTagParser } from './ThinkTagParser'

export class OpenAICompatibleModelClient implements ModelClient {
  private config: ModelClientConfig

  constructor(config: ModelClientConfig) {
    this.config = config
  }

  updateConfig(config: ModelClientConfig): void {
    this.config = config
  }

  async *chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[]
  ): AsyncIterable<ChatEvent> {
    // baseUrl 应为完整 API 根地址（如 https://api.openai.com/v1），
    // 只需拼接路径后缀 /chat/completions
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`

    const body: Record<string, unknown> = {
      model: this.config.modelId,
      messages: messages.map(m => this.toApiMessage(m)),
      stream: true
    }

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }))
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body)
      })
    } catch (err) {
      yield { type: 'error', error: `请求失败: ${(err as Error).message}` }
      return
    }

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown')
      yield { type: 'error', error: `API 错误 ${response.status}: ${text}` }
      return
    }

    yield { type: 'message_start' }

    // 流式 think 标签解析状态机（处理 content 中的 <think'>'...</think'>' 标签）
    const thinkTagParser = new ThinkTagParser()

    // 累积 tool_calls，SSE 每个 chunk 可能只包含部分信息
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    let finishReason = ''

    const bodyStream = response.body
    if (!bodyStream) {
      yield { type: 'error', error: '响应体为空' }
      return
    }

    const reader = bodyStream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // 保留最后一行（可能不完整）
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed === 'data: [DONE]') continue
          if (!trimmed.startsWith('data: ')) continue

          try {
            const chunk = JSON.parse(trimmed.slice(6))
            const choice = chunk.choices?.[0]
            if (!choice) continue

            const delta = choice.delta
            finishReason = choice.finish_reason ?? finishReason

            // 思考/推理内容增量（DeepSeek、MiniMax 等模型通过此字段返回内部推理过程）
            if (delta?.reasoning_content) {
              yield { type: 'thinking_delta', delta: delta.reasoning_content }
            }

            // 文本增量（经过 think 标签状态机处理）
            if (delta?.content) {
              for (const seg of thinkTagParser.feed(delta.content)) {
                yield {
                  type: seg.type === 'thinking' ? 'thinking_delta' : 'text_delta',
                  delta: seg.content
                }
              }
            }

            // 工具调用增量
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                const existing = pendingToolCalls.get(idx)

                if (tc.id) {
                  // 新的 tool_call 开始
                  pendingToolCalls.set(idx, {
                    id: tc.id,
                    name: tc.function?.name ?? existing?.name ?? '',
                    arguments: tc.function?.arguments ?? existing?.arguments ?? ''
                  })
                } else if (existing) {
                  // 追加 arguments 片段
                  if (tc.function?.arguments) {
                    existing.arguments += tc.function.arguments
                  }
                  if (tc.function?.name) {
                    existing.name = tc.function.name
                  }
                }
              }
            }
          } catch {
            // 解析失败的 chunk 静默跳过
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    // 冲刷 think 标签状态机残留内容
    for (const seg of thinkTagParser.flush()) {
      yield {
        type: seg.type === 'thinking' ? 'thinking_delta' : 'text_delta',
        delta: seg.content
      }
    }

    // 发射完整的 tool_call 事件
    for (const [, tc] of pendingToolCalls) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments
        }
      }
    }

    yield { type: 'message_end', finishReason: finishReason || 'stop' }
  }

  /** 将内部消息格式转为 API 请求格式 */
  private toApiMessage(msg: ChatMessage): Record<string, unknown> {
    const result: Record<string, unknown> = {
      role: msg.role,
      content: msg.content
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      result.tool_calls = msg.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments
        }
      }))
    }

    if (msg.toolCallId) {
      result.tool_call_id = msg.toolCallId
    }

    return result
  }
}
