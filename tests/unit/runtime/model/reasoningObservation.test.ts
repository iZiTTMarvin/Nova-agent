/**
 * reasoning 字段协议观测单测。
 *
 * 覆盖：
 * - 响应用 reasoning 字段 → 后续请求回放也用 reasoning
 * - 响应用 reasoning_content → 回放用 reasoning_content
 * - 空字符串 reasoning 序列化后仍是空字符串，字段不被丢弃
 * - usage.cached_tokens 存在而 prompt_tokens_details 缺失时，rawUsage 补齐 details
 * - SSE 流式观测生效
 * - DeepSeek / GLM / MiniMax / Anthropic 档案行为不变
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import { resolveCacheProfile } from '../../../../src/runtime/model/cacheProfile'
import type { ChatEvent, ChatMessage } from '../../../../src/runtime/model/types'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

async function drain(
  client: OpenAICompatibleModelClient,
  messages: Parameters<OpenAICompatibleModelClient['chat']>[0]
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  for await (const ev of client.chat(messages, undefined)) {
    events.push(ev)
  }
  return events
}

/** 构造一个返回单 SSE chunk（指定 reasoning 字段）然后 [DONE] 的 fetch */
function makeSseResponseWithReasoning(
  field: 'reasoning_content' | 'reasoning',
  value: string,
  opts: { withUsage?: boolean } = {}
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      const delta: Record<string, unknown> = {}
      delta[field] = value
      const choice: Record<string, unknown> = { delta, finish_reason: 'stop' }
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ choices: [choice] })}\n\n`
        )
      )
      if (opts.withUsage) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              usage: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 8 }
            })}\n\n`
          )
        )
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

function captureRequestBody(): { bodies: Array<Record<string, unknown>>; fetch: typeof globalThis.fetch } {
  const bodies: Array<Record<string, unknown>> = []
  const fetch = async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    bodies.push(body)
    return makeSseResponseWithReasoning('reasoning_content', '思考')
  }
  return { bodies, fetch: fetch as typeof globalThis.fetch }
}

describe('reasoning 字段协议观测', () => {
  it('kimi 档案标记为 reasoningWireObservable=true', () => {
    const p = resolveCacheProfile('https://api.moonshot.cn/v1', 'kimi-k2')
    expect(p.reasoningWireObservable).toBe(true)
    expect(p.reasoningWire).toBe('reasoning_content')
  })

  it('deepseek / glm / anthropic / minimax 不标记可观测', () => {
    expect(resolveCacheProfile('https://api.deepseek.com/v1', 'deepseek-chat').reasoningWireObservable).toBeUndefined()
    expect(resolveCacheProfile('https://bigmodel.cn/v1', 'glm-4').reasoningWireObservable).toBeUndefined()
    expect(resolveCacheProfile('https://api.anthropic.com/v1', 'claude-3').reasoningWireObservable).toBeUndefined()
    expect(resolveCacheProfile('https://api.minimax.chat/v1', 'abab6').reasoningWireObservable).toBeUndefined()
  })

  it('reasoningWire 联合类型含 reasoning 变体', () => {
    const catalog = resolveCacheProfile('https://api.moonshot.cn/v1', 'kimi-k2')
    // 类型层面已通过 tsc 校验；这里确认 kimi 默认仍 reasoning_content
    expect(catalog.reasoningWire).toBe('reasoning_content')
  })

  it('响应用 reasoning 字段 → 后续请求回放也用 reasoning', async () => {
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: 'test',
      modelId: 'kimi-k2',
      cacheProfile: 'kimi'
    })
    const bodies: Array<Record<string, unknown>> = []

    // 第一次：响应用 reasoning（非 reasoning_content）字段
    globalThis.fetch = async () => makeSseResponseWithReasoning('reasoning', '一轮思考')

    const events1 = await drain(client, [{ role: 'user', content: 'hi' }])
    expect(events1.some(e => e.type === 'thinking_delta')).toBe(true)

    // 第二次：回放历史。观测态已切换为 reasoning，请求体 assistant 应带 reasoning 字段。
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      bodies.push(body)
      return makeSseResponseWithReasoning('reasoning', '二轮思考')
    }

    // 构造一条带 reasoningContent 的 assistant 历史消息
    const history: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '回答', reasoningContent: '历史思考', reasoningProviderId: 'kimi' },
      { role: 'user', content: 'again' }
    ]
    await drain(client, history)

    // 回放请求体中 assistant 消息应使用 reasoning 字段（观测结果），而非 reasoning_content
    const assistantMsgs = (bodies[0].messages as Array<Record<string, unknown>>).filter(
      m => m.role === 'assistant'
    )
    expect(assistantMsgs.length).toBeGreaterThan(0)
    expect('reasoning' in assistantMsgs[0]).toBe(true)
    expect('reasoning_content' in assistantMsgs[0]).toBe(false)
    expect(assistantMsgs[0].reasoning).toBe('历史思考')
  })

  it('响应用 reasoning_content → 回放用 reasoning_content', async () => {
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: 'test',
      modelId: 'kimi-k2',
      cacheProfile: 'kimi'
    })
    // 观测到 reasoning_content
    globalThis.fetch = async () => makeSseResponseWithReasoning('reasoning_content', '思考')
    await drain(client, [{ role: 'user', content: 'hi' }])

    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>)
      return makeSseResponseWithReasoning('reasoning_content', '思考2')
    }
    await drain(client, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a', reasoningContent: 'rc', reasoningProviderId: 'kimi' },
      { role: 'user', content: 'b' }
    ])
    const assistantMsgs = (bodies[0].messages as Array<Record<string, unknown>>).filter(
      m => m.role === 'assistant'
    )
    expect('reasoning_content' in assistantMsgs[0]).toBe(true)
    expect('reasoning' in assistantMsgs[0]).toBe(false)
  })

  it('空字符串 reasoning 经序列化后仍是空字符串，字段不被丢弃', async () => {
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: 'test',
      modelId: 'kimi-k2',
      cacheProfile: 'kimi'
    })
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>)
      return makeSseResponseWithReasoning('reasoning_content', 'x')
    }
    await drain(client, [
      { role: 'user', content: 'hi' },
      // reasoningContent 为空串：不得被当作「没有 reasoning」丢弃
      { role: 'assistant', content: 'a', reasoningContent: '', reasoningProviderId: 'kimi' },
      { role: 'user', content: 'b' }
    ])
    const assistantMsgs = (bodies[0].messages as Array<Record<string, unknown>>).filter(
      m => m.role === 'assistant'
    )
    // JSON.stringify 天然保留空字符串字段；出站值就是 '' 而非任何占位串
    expect('reasoning_content' in assistantMsgs[0]).toBe(true)
    expect(assistantMsgs[0].reasoning_content).toBe('')
  })

  it('usage.cached_tokens 存在而 prompt_tokens_details 缺失时，rawUsage 补齐 details', async () => {
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: 'test',
      modelId: 'kimi-k2',
      cacheProfile: 'kimi'
    })
    globalThis.fetch = async () => makeSseResponseWithReasoning('reasoning_content', 'x', { withUsage: true })
    const events = await drain(client, [{ role: 'user', content: 'hi' }])
    const usageEvent = events.find(e => e.type === 'usage') as Extract<ChatEvent, { type: 'usage' }> | undefined
    expect(usageEvent).toBeDefined()
    // 补齐前：顶层有 cached_tokens=8 但 prompt_tokens_details 缺该字段。
    // normalizeRawUsageDetails 把它补进 details，使 rawUsage 口径与 NormalizedUsage 一致。
    expect(usageEvent!.usage.cacheReadTokens).toBe(8)
    const details = (usageEvent!.usage.rawUsage as Record<string, unknown>).prompt_tokens_details as Record<string, unknown> | undefined
    expect(details?.cached_tokens).toBe(8)
  })
})

describe('回归：其他档案行为不变', () => {
  it('minimax think-tag 路径仍注回 content', async () => {
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.minimax.chat/v1',
      apiKey: 'test',
      modelId: 'abab6',
      cacheProfile: 'minimax'
    })
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>)
      return makeSseResponseWithReasoning('reasoning_content', 'x')
    }
    await drain(client, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a', reasoningContent: '<思考>', reasoningProviderId: 'minimax' },
      { role: 'user', content: 'b' }
    ])
    const assistantMsgs = (bodies[0].messages as Array<Record<string, unknown>>).filter(
      m => m.role === 'assistant'
    )
    // think-tag：reasoning 注回 content 开头，不作为独立字段
    expect('reasoning_content' in assistantMsgs[0]).toBe(false)
    expect('reasoning' in assistantMsgs[0]).toBe(false)
    expect(assistantMsgs[0].content).toBe('<think><思考></think>a')
  })

  it('deepseek reasoningReplay=tool-call-history：纯文本 assistant 不回放 reasoning', async () => {
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test',
      modelId: 'deepseek-chat',
      cacheProfile: 'deepseek'
    })
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>)
      return makeSseResponseWithReasoning('reasoning_content', 'x')
    }
    await drain(client, [
      { role: 'user', content: 'hi' },
      // 无 tool_calls 的 assistant：deepseek 不回放 reasoning
      { role: 'assistant', content: '纯文本回答', reasoningContent: '不应回放', reasoningProviderId: 'deepseek' },
      { role: 'user', content: 'b' }
    ])
    const assistantMsgs = (bodies[0].messages as Array<Record<string, unknown>>).filter(
      m => m.role === 'assistant'
    )
    expect('reasoning_content' in assistantMsgs[0]).toBe(false)
  })

  it('glm all-history：带 reasoningContent 的 assistant 回放 reasoning_content（空串也为空串）', async () => {
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://bigmodel.cn/v1',
      apiKey: 'test',
      modelId: 'glm-4',
      cacheProfile: 'glm'
    })
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>)
      return makeSseResponseWithReasoning('reasoning_content', 'x')
    }
    await drain(client, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a', reasoningContent: '', reasoningProviderId: 'glm' },
      { role: 'user', content: 'b' }
    ])
    const assistantMsgs = (bodies[0].messages as Array<Record<string, unknown>>).filter(
      m => m.role === 'assistant'
    )
    expect('reasoning_content' in assistantMsgs[0]).toBe(true)
    expect(assistantMsgs[0].reasoning_content).toBe('')
  })

  it('anthropic reasoningReplay=none：reasoningContent 永不写入请求体', async () => {
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'test',
      modelId: 'claude-3-5-sonnet',
      cacheProfile: 'anthropic'
    })
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>)
      return makeSseResponseWithReasoning('reasoning_content', 'x')
    }
    await drain(client, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a', reasoningContent: '不应出现', reasoningProviderId: 'anthropic' },
      { role: 'user', content: 'b' }
    ])
    const assistantMsgs = (bodies[0].messages as Array<Record<string, unknown>>).filter(
      m => m.role === 'assistant'
    )
    expect('reasoning_content' in assistantMsgs[0]).toBe(false)
    expect('reasoning' in assistantMsgs[0]).toBe(false)
  })
})

describe('降级前置切换：可观测档案 reasoning_content 400', () => {
  function make400ReasoningContent(): Response {
    return new Response(
      JSON.stringify({ error: { message: 'Unknown parameter: reasoning_content', type: 'invalid_request_error' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  it('切换到 reasoning 字段后成功 → 重试 body 用 reasoning 字段', async () => {
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: 'test',
      modelId: 'kimi-k2',
      cacheProfile: 'kimi'
    })
    const bodies: Array<Record<string, unknown>> = []
    let call = 0
    globalThis.fetch = async (_url, init) => {
      call++
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      bodies.push(body)
      if (call === 1) return make400ReasoningContent()
      // 第二次（切换后）：成功
      return makeSseResponseWithReasoning('reasoning', '切换后思考')
    }
    // 带一条 reasoning_content 历史，触发 detectDowngradeCapability 命中
    await drain(client, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a', reasoningContent: '历史思考', reasoningProviderId: 'kimi' },
      { role: 'user', content: 'b' }
    ])
    // 第一次请求带 reasoning_content，第二次（切换后）带 reasoning
    const firstAssistant = (bodies[0].messages as Array<Record<string, unknown>>).find(
      m => m.role === 'assistant'
    ) as Record<string, unknown> | undefined
    const secondAssistant = (bodies[1].messages as Array<Record<string, unknown>>).find(
      m => m.role === 'assistant'
    ) as Record<string, unknown> | undefined
    expect('reasoning_content' in (firstAssistant ?? {})).toBe(true)
    expect('reasoning' in (secondAssistant ?? {})).toBe(true)
  })

  it('不可观测档案（deepseek）reasoning_content 400 → 不切换，直接剥离降级', async () => {
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test',
      modelId: 'deepseek-chat',
      cacheProfile: 'deepseek'
    })
    const bodies: Array<Record<string, unknown>> = []
    let call = 0
    globalThis.fetch = async (_url, init) => {
      call++
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      bodies.push(body)
      if (call === 1) return make400ReasoningContent()
      return makeSseResponseWithReasoning('reasoning_content', '剥离后成功')
    }
    await drain(client, [
      { role: 'user', content: 'hi' },
      // deepseek tool-call-history：assistant 带 tool_calls 且配对 tool result 才回放 reasoning
      { role: 'assistant', content: 'a', reasoningContent: '历史', reasoningProviderId: 'deepseek', toolCalls: [{ id: 'c1', name: 'bash', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'tool output' },
      { role: 'user', content: 'b' }
    ])
    // deepseek 不可观测：不走切换，第一次 400 后直接剥离 reasoning_content
    expect(client.getDisabledCapabilities().has('reasoning_content')).toBe(true)
    const secondAssistant = (bodies[1].messages as Array<Record<string, unknown>>).find(
      m => m.role === 'assistant'
    ) as Record<string, unknown> | undefined
    expect('reasoning_content' in (secondAssistant ?? {})).toBe(false)
    expect('reasoning' in (secondAssistant ?? {})).toBe(false)
  })
})
