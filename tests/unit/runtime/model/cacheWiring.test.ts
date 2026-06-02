import { describe, it, expect } from 'vitest'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import type { ChatMessage, ModelClientConfig } from '../../../../src/runtime/model/types'

/**
 * C4 端到端接线测试
 * 验证 cacheStrategy 从配置到请求体的完整链路：
 * ModelClientConfig.cacheStrategy → OpenAICompatibleModelClient → 请求体中的 cache_control
 */

/** 拦截 fetch 请求，捕获请求体 */
function interceptFetch(): { body: Record<string, unknown> | null; restore: () => void } {
  const originalFetch = globalThis.fetch
  let capturedBody: Record<string, unknown> | null = null

  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) {
      capturedBody = JSON.parse(init.body as string)
    }
    // 返回一个最小的 SSE 响应
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  return {
    get body() { return capturedBody },
    restore: () => { globalThis.fetch = originalFetch }
  }
}

describe('C4 缓存策略端到端接线', () => {
  it('cacheStrategy=anthropic 时请求体消息带 cache_control 标记', async () => {
    const interceptor = interceptFetch()

    try {
      const config: ModelClientConfig = {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        modelId: 'test-model',
        cacheStrategy: 'anthropic'
      }

      const client = new OpenAICompatibleModelClient(config)

      const messages: ChatMessage[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'how are you' }
      ]

      // 消费流
      for await (const _event of client.chat(messages)) {
        // 只需触发请求
      }

      const body = interceptor.body
      expect(body).not.toBeNull()

      const apiMessages = body!.messages as Array<Record<string, unknown>>
      expect(apiMessages).toBeDefined()
      expect(apiMessages.length).toBe(4)

      // 最后两条非 system 消息应带 cache_control
      // messages[2] = assistant (倒数第2条非 system)
      const assistantContent = apiMessages[2].content
      expect(Array.isArray(assistantContent)).toBe(true)
      const assistantBlocks = assistantContent as Array<Record<string, unknown>>
      expect(assistantBlocks[assistantBlocks.length - 1].cache_control).toEqual({ type: 'ephemeral' })

      // messages[3] = user (最后一条)
      const userContent = apiMessages[3].content
      expect(Array.isArray(userContent)).toBe(true)
      const userBlocks = userContent as Array<Record<string, unknown>>
      expect(userBlocks[userBlocks.length - 1].cache_control).toEqual({ type: 'ephemeral' })

      // system 消息不应带 cache_control
      expect(apiMessages[0].content).toBe('system prompt')
    } finally {
      interceptor.restore()
    }
  })

  it('cacheStrategy=auto 时请求体消息不带 cache_control', async () => {
    const interceptor = interceptFetch()

    try {
      const config: ModelClientConfig = {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        modelId: 'test-model',
        cacheStrategy: 'auto'
      }

      const client = new OpenAICompatibleModelClient(config)

      const messages: ChatMessage[] = [
        { role: 'user', content: 'hello' }
      ]

      for await (const _event of client.chat(messages)) {}

      const body = interceptor.body
      const apiMessages = body!.messages as Array<Record<string, unknown>>

      // auto 策略下 content 应保持原始字符串
      expect(typeof apiMessages[0].content).toBe('string')
      expect(apiMessages[0].content).toBe('hello')
    } finally {
      interceptor.restore()
    }
  })

  it('updateConfig 传入 cacheStrategy 后生效', async () => {
    const interceptor = interceptFetch()

    try {
      const config: ModelClientConfig = {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        modelId: 'test-model'
        // 无 cacheStrategy，默认 auto
      }

      const client = new OpenAICompatibleModelClient(config)

      // 更新配置，加入 anthropic 策略
      client.updateConfig({ ...config, cacheStrategy: 'anthropic' })

      const messages: ChatMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' }
      ]

      for await (const _event of client.chat(messages)) {}

      const body = interceptor.body
      const apiMessages = body!.messages as Array<Record<string, unknown>>

      // 最后一条应带 cache_control
      const lastContent = apiMessages[1].content
      expect(Array.isArray(lastContent)).toBe(true)
    } finally {
      interceptor.restore()
    }
  })

  it('setCacheStrategy 显式覆盖生效', async () => {
    const interceptor = interceptFetch()

    try {
      const config: ModelClientConfig = {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        modelId: 'test-model'
      }

      const client = new OpenAICompatibleModelClient(config)
      client.setCacheStrategy('anthropic')

      const messages: ChatMessage[] = [
        { role: 'user', content: 'test' }
      ]

      for await (const _event of client.chat(messages)) {}

      const body = interceptor.body
      const apiMessages = body!.messages as Array<Record<string, unknown>>
      const content = apiMessages[0].content
      expect(Array.isArray(content)).toBe(true)
    } finally {
      interceptor.restore()
    }
  })
})
