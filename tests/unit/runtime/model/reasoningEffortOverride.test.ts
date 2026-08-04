/**
 * 请求级思考强度覆盖：ChatOptions.reasoningEffort 优先于 client config 的模型默认值；
 * 'auto' 是合法覆盖值（显式不发送参数），仅 undefined 才回落默认。
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

async function drainBody(
  client: OpenAICompatibleModelClient,
  options?: Parameters<OpenAICompatibleModelClient['chat']>[2]
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | null = null
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init!.body as string) as Record<string, unknown>
    return makeSseOkResponse()
  }
  const events: ChatEvent[] = []
  for await (const ev of client.chat([{ role: 'user', content: 'hi' }], undefined, options)) {
    events.push(ev)
  }
  expect(events.some(e => e.type === 'error')).toBe(false)
  expect(captured).not.toBeNull()
  return captured!
}

describe('请求级思考强度覆盖（ChatOptions.reasoningEffort）', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const makeClient = (reasoningEffort?: 'auto' | 'low' | 'medium' | 'high' | 'max') =>
    new OpenAICompatibleModelClient({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      ...(reasoningEffort ? { reasoningEffort } : {})
    })

  it('覆盖值优先于模型默认值', async () => {
    const body = await drainBody(makeClient('high'), { reasoningEffort: 'max' })
    expect(body.reasoning_effort).toBe('max')
  })

  it('无覆盖时回落模型默认值', async () => {
    const body = await drainBody(makeClient('high'))
    expect(body.reasoning_effort).toBe('high')
  })

  it('auto 覆盖显式不发送参数，不被默认值回填', async () => {
    const body = await drainBody(makeClient('high'), { reasoningEffort: 'auto' })
    expect('reasoning_effort' in body).toBe(false)
  })

  it('默认与覆盖均缺省时不发送参数', async () => {
    const body = await drainBody(makeClient())
    expect('reasoning_effort' in body).toBe(false)
  })
})
