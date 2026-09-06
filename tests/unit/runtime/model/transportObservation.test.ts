import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import { resolveRouteIdentity } from '../../../../src/runtime/model/routeIdentity'
import { DEFAULT_TRANSPORT_TIMEOUTS, TransportAttempt, TransportBodyReader } from '../../../../src/runtime/model/ModelTransport'
import { getMetricBuffer, registerMetricSink, resetMetricsForTests } from '../../../../src/shared/diagnostics/metrics'
import type { ChatEvent } from '../../../../src/runtime/model/types'

const config = { baseUrl: 'https://example.test/v1', apiKey: 'private-fixture-key', modelId: 'model', cacheProfile: 'openai' as const }
function response(): Response {
  return new Response([
    'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":80}}}',
    'data: [DONE]', ''
  ].join('\n\n'), { headers: { 'Content-Type': 'text/event-stream' } })
}
async function drain(client: OpenAICompatibleModelClient): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  for await (const event of client.chat([{ role: 'user', content: 'private-fixture-prompt' }], undefined, {
    promptCacheKey: 'fixture-routing', observation: { logicalRequestId: 'logical', runId: 'run', sessionId: 'session' }
  })) events.push(event)
  return events
}
const previous = process.env.NOVA_METRICS
afterEach(() => {
  resetMetricsForTests()
  if (previous === undefined) delete process.env.NOVA_METRICS
  else process.env.NOVA_METRICS = previous
})

describe('物理请求观测', () => {
  it('pending read 被用户取消唤醒为 EOF 时，观测终态仍为 cancelled', async () => {
    const controller = new AbortController()
    const attempt = new TransportAttempt(controller.signal, undefined)
    const reader = new TransportBodyReader(new ReadableStream<Uint8Array>(), { userSignal: controller.signal, attempt })
    try {
      const pending = reader.read()
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'cancelled' })
      expect(attempt.getOutcome()).toBe('cancelled')
      expect(attempt.getTiming().abortRequestedAt).not.toBeNull()
      expect(attempt.getTiming().settledAt).not.toBeNull()
    } finally {
      reader.release()
    }
  })
  it('观测开关不改变 wire、事件结果、能力降级次数和等待策略', async () => {
    const runs: string[][] = []
    for (const enabled of ['0', '1']) {
      process.env.NOVA_METRICS = enabled
      resetMetricsForTests()
      registerMetricSink(() => {})
      const bodies: string[] = []
      const client = new OpenAICompatibleModelClient({ ...config, fetchImpl: async (_url, init) => {
        bodies.push(String(init?.body))
        return bodies.length === 1
          ? new Response('{"error":{"message":"Unknown parameter: prompt_cache_key"}}', { status: 400 })
          : response()
      } })
      const events = await drain(client)
      expect(events.filter(e => e.type === 'text_delta')).toEqual([{ type: 'text_delta', delta: 'answer' }])
      expect(events.at(-1)).toEqual({ type: 'message_end', finishReason: 'stop' })
      expect(bodies).toHaveLength(2)
      runs.push(bodies)
      if (enabled === '0') expect(getMetricBuffer()).toHaveLength(0)
    }
    expect(runs[0]).toEqual(runs[1])
    expect(DEFAULT_TRANSPORT_TIMEOUTS).toMatchObject({ connectMs: 30_000, firstByteMs: 60_000, idleMs: 90_000 })
    const attempts = getMetricBuffer().filter(e => e.category === 'transport.attempt')
    const usage = getMetricBuffer().filter(e => e.category === 'usage.report')
    expect(attempts).toHaveLength(2)
    expect(new Set(attempts.map(e => e.tags?.physicalAttemptId)).size).toBe(2)
    expect(attempts.map(e => e.id)).toEqual(['logical', 'logical'])
    expect(attempts.map(e => e.tags?.outcome)).toEqual(['http_error', 'completed'])
    expect(attempts.map(e => e.tags?.downgrade)).toEqual(['none', 'prompt_cache_key'])
    expect(usage.map(e => e.tags?.usageReport)).toEqual(['missing', 'reported'])
    expect(usage[0].values).toEqual({})
    expect(usage[1].values.promptTokens).toBe(100)
    for (const [i, attempt] of attempts.entries()) {
      expect(attempt.tags?.wireBodyHash).toBe(createHash('sha256').update(runs[1][i]).digest('hex'))
      expect(attempt.tags).toMatchObject({ runId: 'run', sessionId: 'session', connectBreakdown: 'unavailable' })
      expect(attempt.values.headersAt).toBeGreaterThanOrEqual(attempt.values.dispatchedAt)
      expect(attempt.values.settledAt).toBeGreaterThanOrEqual(attempt.values.headersAt)
    }
    expect(attempts[0].values.firstSemanticAt).toBeUndefined()
    expect(attempts[1].values.firstSemanticAt).toBeGreaterThanOrEqual(attempts[1].values.headersAt)
    const log = JSON.stringify(getMetricBuffer())
    expect(log).not.toContain('private-fixture')
    expect(log).not.toContain('Authorization')
    expect(log).not.toContain('fixture-routing')
  })

  it('重复正文按不同物理尝试计账，消费者提前退出仍有缺失记录', async () => {
    process.env.NOVA_METRICS = '1'
    registerMetricSink(() => {})
    const client = new OpenAICompatibleModelClient({ ...config, fetchImpl: async () => response() })
    await drain(client)
    await drain(client)
    const attempts = getMetricBuffer().filter(e => e.category === 'transport.attempt')
    expect(attempts).toHaveLength(2)
    expect(attempts[0].tags?.wireBodyHash).toBe(attempts[1].tags?.wireBodyHash)
    expect(attempts[0].tags?.physicalAttemptId).not.toBe(attempts[1].tags?.physicalAttemptId)
    expect(getMetricBuffer().filter(e => e.category === 'usage.report').reduce((sum, e) => sum + e.values.promptTokens, 0)).toBe(200)
    for await (const event of client.chat([{ role: 'user', content: 'early' }])) {
      if (event.type === 'wire_snapshot') break
    }
    const last = getMetricBuffer().filter(e => e.category === 'transport.attempt').at(-1)!
    expect(last.tags?.outcome).toBe('abandoned')
    expect(last.values.settledAt).toBeGreaterThanOrEqual(last.values.dispatchedAt)
    expect(getMetricBuffer().filter(e => e.category === 'usage.report').at(-1)?.tags?.usageReport).toBe('missing')
  })

  it('同 profile 下端点路径和 effort 可区分，路由不暴露 URL 凭据与查询', () => {
    const a = resolveRouteIdentity({ ...config, baseUrl: 'https://user:password@example.test/private-path?secret=value' })
    const b = resolveRouteIdentity({ ...config, baseUrl: 'https://example.test/another-path' })
    expect(a.routeId).not.toBe(b.routeId)
    expect(resolveRouteIdentity({ ...config, reasoningEffort: 'high' }).routeId).not.toBe(resolveRouteIdentity({ ...config, reasoningEffort: 'low' }).routeId)
    expect(JSON.stringify(a)).not.toMatch(/password|private-path|secret|value/)
  })

  it('连接失败只记一次物理尝试，缺失阶段和 usage 不补零', async () => {
    process.env.NOVA_METRICS = '1'
    registerMetricSink(() => {})
    const client = new OpenAICompatibleModelClient({ ...config, fetchImpl: async () => { throw new Error('ECONNRESET') } })
    expect((await drain(client)).at(-1)?.type).toBe('error')
    const attempts = getMetricBuffer().filter(e => e.category === 'transport.attempt')
    expect(attempts).toHaveLength(1)
    expect(attempts[0].tags?.outcome).toBe('transport_error')
    expect(attempts[0].values.headersAt).toBeUndefined()
    expect(attempts[0].values.firstSemanticAt).toBeUndefined()
    expect(attempts[0].values.settledAt).toBeGreaterThanOrEqual(attempts[0].values.dispatchedAt)
    expect(getMetricBuffer().filter(e => e.category === 'usage.report').map(e => e.values)).toEqual([{}])
  })
})
