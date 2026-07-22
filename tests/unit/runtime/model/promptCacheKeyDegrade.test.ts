/**
 * 会话级能力记忆：首轮 400 精确剥离重试后，后续请求直接降级形态，不再 400。
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

async function drain(
  client: OpenAICompatibleModelClient,
  messages: Parameters<OpenAICompatibleModelClient['chat']>[0],
  options?: Parameters<OpenAICompatibleModelClient['chat']>[2]
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  for await (const ev of client.chat(messages, undefined, options)) {
    events.push(ev)
  }
  return events
}

describe('会话级能力记忆（capability downgrade）', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('prompt_cache_key：首轮 400 剥离重试成功，第二轮直接不带该字段且零 400', async () => {
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
      expect('prompt_cache_key' in body).toBe(false)
      return makeSseOkResponse()
    }

    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: 'test-key',
      modelId: 'kimi-k2',
      cacheProfile: 'kimi'
    })

    const events1 = await drain(client, [{ role: 'user', content: 'hi' }], {
      promptCacheKey: 'route-key-1'
    })
    expect(callCount).toBe(2)
    expect(events1.some(e => e.type === 'capability_downgrade')).toBe(true)
    expect(client.getDisabledCapabilities().has('prompt_cache_key')).toBe(true)

    // 第二轮：直接降级，不再 400
    const before = callCount
    const events2 = await drain(client, [{ role: 'user', content: 'again' }], {
      promptCacheKey: 'route-key-1'
    })
    expect(callCount).toBe(before + 1)
    expect('prompt_cache_key' in bodies[bodies.length - 1]).toBe(false)
    expect(events2.some(e => e.type === 'capability_downgrade')).toBe(false)
    expect(events2.some(e => e.type === 'error')).toBe(false)
  })

  it('其他 400（不含已知能力字段）不重试', async () => {
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

    const events = await drain(client, [{ role: 'user', content: 'hi' }], {
      promptCacheKey: 'route-key-1'
    })

    expect(callCount).toBe(1)
    expect(events.some(e => e.type === 'capability_downgrade')).toBe(false)
    expect(events.some(e => e.type === 'error')).toBe(true)
  })

  it('clear_thinking：首轮 400 剥离后第二轮不再携带', async () => {
    const bodies: Array<Record<string, unknown>> = []
    let callCount = 0

    globalThis.fetch = async (_url, init) => {
      callCount++
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      bodies.push(body)
      if (callCount === 1) {
        const thinking = body.thinking as Record<string, unknown>
        expect(thinking.clear_thinking).toBe(false)
        return new Response(
          JSON.stringify({ error: { message: 'Unknown parameter: clear_thinking' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      }
      const thinking = body.thinking as Record<string, unknown> | undefined
      expect(thinking).toBeDefined()
      expect(thinking).not.toHaveProperty('clear_thinking')
      return makeSseOkResponse()
    }

    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'test-key',
      modelId: 'glm-4',
      cacheProfile: 'glm',
      reasoningEffort: 'auto'
    })

    const events1 = await drain(client, [{ role: 'user', content: 'hi' }])
    expect(callCount).toBe(2)
    expect(
      events1.some(
        e => e.type === 'capability_downgrade' && e.capability === 'clear_thinking'
      )
    ).toBe(true)

    const before = callCount
    await drain(client, [{ role: 'user', content: 'again' }])
    expect(callCount).toBe(before + 1)
    const lastThinking = bodies[bodies.length - 1].thinking as Record<string, unknown>
    expect(lastThinking).not.toHaveProperty('clear_thinking')
  })

  it('reasoning_content：首轮 400 剥离后第二轮不再携带', async () => {
    const bodies: Array<Record<string, unknown>> = []
    let callCount = 0

    globalThis.fetch = async (_url, init) => {
      callCount++
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      bodies.push(body)
      if (callCount === 1) {
        const messages = body.messages as Array<Record<string, unknown>>
        expect(messages.some(m => 'reasoning_content' in m)).toBe(true)
        return new Response(
          JSON.stringify({ error: { message: 'Unknown field: reasoning_content' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      }
      const messages = body.messages as Array<Record<string, unknown>>
      expect(messages.every(m => !('reasoning_content' in m))).toBe(true)
      return makeSseOkResponse()
    }

    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'test-key',
      modelId: 'glm-4',
      cacheProfile: 'glm'
    })

    const history = [
      { role: 'user' as const, content: 'q' },
      {
        role: 'assistant' as const,
        content: 'a',
        reasoningContent: '思考过程',
        reasoningProviderId: 'glm'
      }
    ]

    const events1 = await drain(client, history)
    expect(callCount).toBe(2)
    expect(
      events1.some(
        e => e.type === 'capability_downgrade' && e.capability === 'reasoning_content'
      )
    ).toBe(true)

    const before = callCount
    await drain(client, history)
    expect(callCount).toBe(before + 1)
    const lastMessages = bodies[bodies.length - 1].messages as Array<Record<string, unknown>>
    expect(lastMessages.every(m => !('reasoning_content' in m))).toBe(true)
  })

  it('降级重试失败后不再第三次请求', async () => {
    let callCount = 0
    globalThis.fetch = async () => {
      callCount++
      return new Response(
        JSON.stringify({
          error: {
            message: callCount === 1 ? 'Unknown parameter prompt_cache_key' : 'still broken'
          }
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

    const events = await drain(client, [{ role: 'user', content: 'hi' }], {
      promptCacheKey: 'k'
    })

    expect(callCount).toBe(2)
    expect(events.filter(e => e.type === 'capability_downgrade')).toHaveLength(1)
    expect(events.some(e => e.type === 'error')).toBe(true)
  })

  it('并发 turn 隔离：pool A 的降级不污染共享同一底层 client 的 pool B', async () => {
    // 复用 promptCacheKey 降级路径：两个 pool 共享同一底层 client 实例。
    // pool A 触发降级后，pool B（并发 turn）的请求体仍应正常携带 prompt_cache_key，
    // 不被 A 的降级污染。
    const { ModelClientPool } = await import('../../../../src/runtime/model/ModelClientPool')
    const bodies: Array<Record<string, unknown>> = []
    let callCount = 0

    globalThis.fetch = async (_url, init) => {
      callCount++
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      bodies.push(body)
      // pool A 第一次请求 → 400 降级重试 → 成功；之后全部直接成功
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ error: { message: 'Unknown parameter: prompt_cache_key' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return makeSseOkResponse()
    }

    const sharedClient = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: 'test-key',
      modelId: 'kimi-k2',
      cacheProfile: 'kimi'
    })
    const poolA = new ModelClientPool({
      primary: sharedClient,
      primaryConfig: {
        provider: 'openai', name: 'k', baseUrl: 'x', apiKey: 'k', modelId: 'kimi-k2'
      } as never
    })
    const poolB = new ModelClientPool({
      primary: sharedClient,
      primaryConfig: {
        provider: 'openai', name: 'k', baseUrl: 'x', apiKey: 'k', modelId: 'kimi-k2'
      } as never
    })

    // pool A：触发降级（第 1 次 400，第 2 次重试成功）
    const eventsA: ChatEvent[] = []
    for await (const ev of poolA.chat([{ role: 'user', content: 'a' }], undefined, {
      promptCacheKey: 'route-A'
    })) {
      eventsA.push(ev)
    }
    expect(eventsA.some(e => e.type === 'capability_downgrade')).toBe(true)
    // pool A 第二次请求（降级重试）应不带 prompt_cache_key
    expect('prompt_cache_key' in bodies[1]).toBe(false)

    // pool B：并发 turn，请求体应正常携带 prompt_cache_key（不被 A 污染）
    const eventsB: ChatEvent[] = []
    for await (const ev of poolB.chat([{ role: 'user', content: 'b' }], undefined, {
      promptCacheKey: 'route-B'
    })) {
      eventsB.push(ev)
    }
    expect(eventsB.some(e => e.type === 'error')).toBe(false)
    // pool B 的请求体应仍带 prompt_cache_key（隔离生效）
    const lastBody = bodies[bodies.length - 1]
    expect(lastBody.prompt_cache_key).toBe('route-B')
  })
})
