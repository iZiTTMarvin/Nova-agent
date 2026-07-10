/**
 * T2-4：prompt_cache_key 精确降级
 *
 * - 400 且错误文案含 prompt_cache_key → 剥离该字段重试一次
 * - 其他 400 不重试
 * - 降级只发生在 HTTP 层，不触发工具重跑
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import type { ChatEvent } from '../../../../src/runtime/model/types'

function makeSseOkResponse(): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n')
      )
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

describe('T2-4 prompt_cache_key 精确降级', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('未知参数 prompt_cache_key：剥离后只重试一次，第二次 body 无该字段', async () => {
    const bodies: Array<Record<string, unknown>> = []
    let callCount = 0

    globalThis.fetch = async (_url, init) => {
      callCount++
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      bodies.push(body)
      if (callCount === 1) {
        expect(body.prompt_cache_key).toBe('route-key-1')
        return new Response(
          JSON.stringify({
            error: { message: 'Unknown parameter: prompt_cache_key', type: 'invalid_request_error' }
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      }
      // 第二次：应已剥离
      expect('prompt_cache_key' in body).toBe(false)
      return makeSseOkResponse()
    }

    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: 'test-key',
      modelId: 'kimi-k2',
      cacheProfile: 'kimi'
    })

    const events: ChatEvent[] = []
    for await (const ev of client.chat(
      [{ role: 'user', content: 'hi' }],
      undefined,
      { promptCacheKey: 'route-key-1' }
    )) {
      events.push(ev)
    }

    expect(callCount).toBe(2)
    expect(bodies).toHaveLength(2)
    expect(bodies[0].prompt_cache_key).toBe('route-key-1')
    expect('prompt_cache_key' in bodies[1]).toBe(false)
    expect(events.some(e => e.type === 'prompt_cache_key_stripped')).toBe(true)
    expect(events.some(e => e.type === 'text_delta')).toBe(true)
    expect(events.some(e => e.type === 'error')).toBe(false)
  })

  it('其他 400（不含 prompt_cache_key）不重试', async () => {
    let callCount = 0
    globalThis.fetch = async () => {
      callCount++
      return new Response(
        JSON.stringify({ error: { message: 'invalid temperature value' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: 'test-key',
      modelId: 'kimi-k2',
      cacheProfile: 'kimi'
    })

    const events: ChatEvent[] = []
    for await (const ev of client.chat(
      [{ role: 'user', content: 'hi' }],
      undefined,
      { promptCacheKey: 'route-key-1' }
    )) {
      events.push(ev)
    }

    expect(callCount).toBe(1)
    expect(events.some(e => e.type === 'prompt_cache_key_stripped')).toBe(false)
    expect(events.some(e => e.type === 'error')).toBe(true)
  })

  it('降级重试失败后不再第三次请求', async () => {
    let callCount = 0
    globalThis.fetch = async () => {
      callCount++
      return new Response(
        JSON.stringify({
          error: { message: callCount === 1 ? 'Unknown parameter prompt_cache_key' : 'still broken' }
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      modelId: 'gpt-4o',
      cacheProfile: 'openai'
    })

    const events: ChatEvent[] = []
    for await (const ev of client.chat(
      [{ role: 'user', content: 'hi' }],
      undefined,
      { promptCacheKey: 'k' }
    )) {
      events.push(ev)
    }

    expect(callCount).toBe(2)
    expect(events.filter(e => e.type === 'prompt_cache_key_stripped')).toHaveLength(1)
    expect(events.some(e => e.type === 'error')).toBe(true)
  })
})
