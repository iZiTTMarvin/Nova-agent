import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelClient, ChatOptions } from '../../../../../src/runtime/model/ModelClient'
import type { ChatMessage, ToolDefinition } from '../../../../../src/runtime/model/types'
import { createClairicProvider } from '../../../../../src/runtime/tools/webFetch/extraction/clairic'
import { createCurrentModelProvider } from '../../../../../src/runtime/tools/webFetch/extraction/modelClient'
import {
  parseExtractFields,
  resolveFieldExtractionProvider
} from '../../../../../src/runtime/tools/webFetch/extraction'

function modelClient(raw: string, calls: Array<{
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  options?: ChatOptions
}> = []): ModelClient {
  return {
    updateConfig: () => undefined,
    chat: (messages, tools, options) => {
      calls.push({ messages, tools, options })
      return (async function *() {
        yield { type: 'text_delta', delta: raw } as const
      })()
    }
  }
}

function request(provider: ReturnType<typeof resolveFieldExtractionProvider>, signal = new AbortController().signal) {
  return provider.extract({
    page: 'Price 42.10',
    fields: parseExtractFields({ price: 'number' }),
    referenceDate: '2026-10-26',
    signal
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('当前模型提取适配器', () => {
  it('使用无工具子调用、独立用途计量和受控 JSON', async () => {
    const calls: Parameters<typeof modelClient>[1] = []
    const client = modelClient('```json\n{"answers":{"price":{"value":42.1,"confidence":0.97}}}\n```', calls)
    const provider = createCurrentModelProvider({ modelClient: client, contextWindow: 32_000 })
    const result = await request(provider)
    expect(result.answers.price).toMatchObject({ value: 42.1 })
    expect(provider.maxEstimatedTokens).toBe(16_000)
    expect(calls).toHaveLength(1)
    expect(calls[0].tools).toEqual([])
    expect(calls[0].options).toMatchObject({ purpose: 'web-extract', maxOutputTokens: 4096 })
    expect(calls[0].messages[1].content).toContain('untrusted_page')
  })

  it('非 JSON 响应明确失败，不猜测或二次请求', async () => {
    const calls: Parameters<typeof modelClient>[1] = []
    const provider = createCurrentModelProvider({ modelClient: modelClient('not-json', calls) })
    await expect(request(provider)).rejects.toThrow('合法 JSON')
    expect(calls).toHaveLength(1)
  })
})

describe('Clairic 适配器与 provider 选择', () => {
  it('发送字段协议和可选网关，凭据不进入结果', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true, result: { answers: { price: { value: 42.1, confidence: 0.99 } } } }))
    )
    vi.stubGlobal('fetch', fetchMock)
    const provider = createClairicProvider({
      CLOUDFLARE_API_KEY: 'test-secret',
      CLOUDFLARE_ACCOUNT_ID: 'account-1',
      CLOUDFLARE_GATEWAY_ID: 'gateway-1'
    })
    const result = await request(provider)
    expect(result.answers.price).toMatchObject({ value: 42.1 })
    const [endpoint, init] = fetchMock.mock.calls[0]
    expect(String(endpoint)).toContain('/accounts/account-1/ai/run/@cf/cloudflare/clairic')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('cf-aig-gateway-id')).toBe('gateway-1')
    expect(String(init?.body)).toContain('"reference_date":"2026-10-26"')
    expect(JSON.stringify(result)).not.toContain('test-secret')
  })

  it('HTTP 错误会先脱敏再截断', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(210) + 'test-secret', { status: 500 })))
    const provider = createClairicProvider({
      CLOUDFLARE_API_KEY: 'test-secret',
      CLOUDFLARE_ACCOUNT_ID: 'account-1'
    })
    await expect(request(provider)).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      return message.includes('HTTP 500') && !message.includes('test-secret') && message.length < 300
    })
  })

  it('配置完整度在调用前决定，Cloudflare 配置不完整时绝不改投当前模型', () => {
    const client = modelClient('{}')
    expect(() => resolveFieldExtractionProvider({
      modelClient: client,
      env: { CLOUDFLARE_API_KEY: 'only-key' }
    })).toThrow('不会自动改投当前模型')
    expect(resolveFieldExtractionProvider({ modelClient: client, env: {} }).name).toBe('current-model')
    expect(resolveFieldExtractionProvider({
      modelClient: client,
      env: { CLOUDFLARE_API_KEY: 'key', CLOUDFLARE_ACCOUNT_ID: 'account' }
    }).name).toBe('clairic')
  })
})
