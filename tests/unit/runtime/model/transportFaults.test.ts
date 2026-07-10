/**
 * ModelTransport 故障注入（T0-2 → T1-1 转绿）
 *
 * 四种故障形态：永不返回响应头 / 有头无首 token / 输出一半后永久静默 / body 抛 ECONNRESET。
 * 通过 ChatOptions.transportTimeouts 把窗口压到秒级，避免单测等待默认 30–90s。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import type { ChatEvent } from '../../../../src/runtime/model/types'

const config = {
  baseUrl: 'http://localhost:19999/v1',
  apiKey: 'test-key',
  modelId: 'test-model'
}

/** 测试用短超时 */
const FAST = { connectMs: 200, firstByteMs: 200, idleMs: 200 }

/** 在限时内消费 chat 流；超时则抛错 */
async function collectWithDeadline(
  client: OpenAICompatibleModelClient,
  deadlineMs: number,
  timeouts = FAST
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  const iter = client.chat(
    [{ role: 'user', content: 'hello' }],
    undefined,
    { transportTimeouts: timeouts }
  )[Symbol.asyncIterator]()

  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`attempt 未在 ${deadlineMs}ms 内结束`)), deadlineMs)
  })

  while (true) {
    const next = await Promise.race([iter.next(), deadline])
    if (next.done) break
    events.push(next.value)
    if (next.value.type === 'error' || next.value.type === 'cancelled' || next.value.type === 'message_end') {
      break
    }
  }
  return events
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ModelTransport 故障注入（T1-1）', () => {
  it('永不返回响应头 → 在 connect timeout 窗口内结束 attempt', async () => {
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise<Response>(() => {
          /* 永不 resolve */
        })
    )

    const client = new OpenAICompatibleModelClient(config)
    const events = await collectWithDeadline(client, 2_000)
    const last = events[events.length - 1]
    expect(last?.type).toBe('error')
    expect(String((last as { error?: string })?.error ?? '')).toMatch(/timeout|connect|超时/i)
  })

  it('返回头但无首 token → 在 first-byte timeout 窗口内结束 attempt', async () => {
    const body = new ReadableStream<Uint8Array>({
      start() {
        /* 永不 enqueue */
      }
    })

    vi.stubGlobal('fetch', async () =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    )

    const client = new OpenAICompatibleModelClient(config)
    const events = await collectWithDeadline(client, 2_000)
    const last = events[events.length - 1]
    expect(last?.type).toBe('error')
    expect(String((last as { error?: string })?.error ?? '')).toMatch(/timeout|first.?byte|首/i)
  })

  it('无限 keepalive 但没有模型事件 → 不得重置首个语义事件超时', async () => {
    const encoder = new TextEncoder()
    let timer: ReturnType<typeof setInterval> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // SSE 注释与 ping 都是传输保活，不能被误认为模型已经开始输出。
        timer = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n\n')), 20)
      },
      cancel() {
        if (timer) clearInterval(timer)
      }
    })

    vi.stubGlobal('fetch', async () =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    )

    const client = new OpenAICompatibleModelClient(config)
    const events = await collectWithDeadline(client, 2_000)
    const last = events[events.length - 1]
    expect(last?.type).toBe('error')
    expect(String((last as { error?: string })?.error ?? '')).toMatch(/首个模型语义事件|first/i)
  })

  it('输出一半后永久静默 → 在 idle timeout 窗口内结束 attempt', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const chunk = JSON.stringify({
          choices: [{ delta: { content: 'half' }, finish_reason: null }]
        })
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`))
        // 之后永不关闭、不再发数据 → idle
      }
    })

    vi.stubGlobal('fetch', async () =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    )

    const client = new OpenAICompatibleModelClient(config)
    const events = await collectWithDeadline(client, 2_000)
    expect(events.some(e => e.type === 'text_delta')).toBe(true)
    const last = events[events.length - 1]
    expect(last?.type).toBe('error')
    expect(String((last as { error?: string })?.error ?? '')).toMatch(/timeout|idle|静默/i)
  })

  it('body 抛 ECONNRESET → 规范化为 network_reset 类错误并结束 attempt', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const chunk = JSON.stringify({
          choices: [{ delta: { content: 'partial' }, finish_reason: null }]
        })
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`))
        const err = new Error('read ECONNRESET')
        ;(err as NodeJS.ErrnoException).code = 'ECONNRESET'
        controller.error(err)
      }
    })

    vi.stubGlobal('fetch', async () =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    )

    const client = new OpenAICompatibleModelClient(config)
    const events = await collectWithDeadline(client, 2_000)
    const errEvent = events.find(e => e.type === 'error') as { type: 'error'; error: string } | undefined
    expect(errEvent).toBeDefined()
    expect(errEvent!.error).toMatch(/network_reset|ECONNRESET|重置/i)
  })

  it('非 2xx 错误体无限流 → 超时后取消 reader 并结束 attempt', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start() {
        /* 永不输出也不结束 */
      },
      cancel() {
        cancelled = true
      }
    })
    vi.stubGlobal('fetch', async () => new Response(body, { status: 503 }))

    const client = new OpenAICompatibleModelClient(config)
    const events = await collectWithDeadline(client, 2_000)
    const last = events[events.length - 1]
    expect(last?.type).toBe('error')
    expect(String((last as { error?: string })?.error ?? '')).toMatch(/http_retryable|503/)
    expect(cancelled).toBe(true)
  })

  it('用户取消时立即取消 reader，避免遗留语义计时器', async () => {
    let cancelled = false
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start() {
        /* 永不输出 */
      },
      cancel() {
        cancelled = true
      }
    })
    vi.stubGlobal('fetch', async () =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    )

    const client = new OpenAICompatibleModelClient(config)
    const iter = client.chat(
      [{ role: 'user', content: 'hello' }],
      undefined,
      { abortSignal: controller.signal, transportTimeouts: { ...FAST, firstByteMs: 1_000 } }
    )[Symbol.asyncIterator]()
    const next = iter.next()
    setTimeout(() => controller.abort(), 20)
    const result = await next
    // T2-5：成功路径先 yield request_fingerprint，再 message_start
    expect(result.value.type).toBe('request_fingerprint')
    const startEvent = await iter.next()
    expect(startEvent.value.type).toBe('message_start')
    const cancelledEvent = await iter.next()
    expect(cancelledEvent.value.type).toBe('cancelled')
    expect(cancelled).toBe(true)
  })
})
