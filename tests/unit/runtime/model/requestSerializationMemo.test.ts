/**
 * 请求序列化共享缓存（RequestSerializationMemo）的一致性门禁：
 * memo 只跳过重复计算，任何路径的哈希输出必须与无 memo 逐字节相同。
 * 防止缓存引入前缀指纹 / 对账哈希偏差，破坏缓存诊断与 transport 对账。
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { computeWireSnapshot, type RequestSerializationMemo } from '../../../../src/runtime/model/requestFingerprint'
import { measureRequestBudget } from '../../../../src/runtime/model/requestBudget'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import type { ChatEvent, ChatMessage } from '../../../../src/runtime/model/types'

function buildBody(): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [
    { role: 'user', content: '检查这个仓库' },
    {
      role: 'assistant',
      content: '好的',
      reasoning_content: '先看目录结构',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read', arguments: '{"path":"src"}' } }]
    },
    { role: 'tool', content: '文件清单...', tool_call_id: 'tc1' }
  ]
  return {
    model: 'glm-4.7',
    stream: true,
    stream_options: { include_usage: true },
    messages,
    tools: [{ type: 'function', function: { name: 'read', description: '读文件', parameters: { type: 'object' } } }]
  }
}

describe('请求序列化 memo 一致性', () => {
  it('Unicode 请求的预算计量、前缀哈希及原始字节保持一致', () => {
    const body = { model: 'fixture', messages: [{ role: 'user', content: 'ASCII 中文\ud800\udc00\udfff\u007f\u0080' }] }
    const raw = JSON.stringify(body)
    let units = 0
    for (const char of raw) {
      const point = char.codePointAt(0)!
      units += point <= 0x7f ? .25 : point <= 0xffff ? 1 : 2
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const expected = {
      routeId: 'main', tokenizerId: 'unknown', contextWindow: 200_000,
      envelopeHash: hash(JSON.stringify({ ...body, messages: null })),
      prefixHashes: [hash(JSON.stringify(body.messages[0]))],
      serializedBytes: Buffer.byteLength(raw), budgetUnits: Math.ceil(units)
    }
    const memo: RequestSerializationMemo = {}
    const wire = computeWireSnapshot(body, 'generic', raw, memo)
    expect(measureRequestBudget(body, 'main', 200_000)).toEqual(expected)
    expect(measureRequestBudget(body, 'main', 200_000, memo)).toEqual(expected)
    expect(wire.rawBodyHash).toBe(hash(raw))
    expect(wire.rawBodyBytes).toBe(expected.serializedBytes)
    expect(memo.bodyJson).toBe(raw)
    expect(JSON.stringify(body)).toBe(raw)
  })

  it('generic 档案：memo 与无 memo 的 WireSnapshot 全字段一致', () => {
    const body = buildBody()
    const rawBody = JSON.stringify(body)

    const withoutMemo = computeWireSnapshot(body, 'glm', rawBody)
    const memo: RequestSerializationMemo = {}
    const first = computeWireSnapshot(body, 'glm', rawBody, memo)
    // 重复调用（chat 内 snapshotEvent 复用 doFetch 的 memo）
    const second = computeWireSnapshot(body, 'glm', memo.bodyJson, memo)

    expect(first).toEqual(withoutMemo)
    expect(second).toEqual(withoutMemo)
    expect(memo.bodyJson).toBe(rawBody)
  })

  it('generic 档案：measureRequestBudget 的 prefix 哈希链不因 memo 改变', () => {
    const body = buildBody()
    const withoutMemo = measureRequestBudget(body, 'main', 200_000)

    const memo: RequestSerializationMemo = {}
    computeWireSnapshot(body, 'glm', JSON.stringify(body), memo)
    const withMemo = measureRequestBudget(body, 'main', 200_000, memo)

    expect(withMemo).toEqual(withoutMemo)
  })

  it('anthropic 档案：深拷贝剥离路径不使用 memo，指纹基于剥离后内容', () => {
    const body = buildBody()
    ;(body.messages as Array<Record<string, unknown>>)[1].cache_control = { type: 'ephemeral' }
    const rawBody = JSON.stringify(body)

    const withoutMemo = computeWireSnapshot(body, 'anthropic', rawBody)
    const memo: RequestSerializationMemo = {}
    const withMemo = computeWireSnapshot(body, 'anthropic', rawBody, memo)

    expect(withMemo).toEqual(withoutMemo)
    // 拷贝路径不得共享任何缓存（防误用：后续同 memo 换 body 会读到旧值）
    expect(memo.bodyJson).toBeUndefined()
    expect(memo.messageJsons).toBeUndefined()
    expect(memo.fingerprints).toBeUndefined()
  })

  it('chat 集成：能力降级剥离后，wire_snapshot 与实际发送的 body 对账一致', async () => {
    const sentRawBodies: string[] = []
    let call = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (_url, init) => {
      call++
      sentRawBodies.push(init!.body as string)
      if (call === 1) {
        return new Response(
          JSON.stringify({ error: { message: 'Unknown parameter: prompt_cache_key', type: 'invalid_request_error' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'))
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
          }
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    }
    try {
      const client = new OpenAICompatibleModelClient({
        baseUrl: 'https://api.moonshot.cn/v1',
        apiKey: 'test-key',
        modelId: 'kimi-k2',
        cacheProfile: 'kimi'
      })
      const events: ChatEvent[] = []
      const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
      for await (const ev of client.chat(messages, undefined, { promptCacheKey: 'route-key-1' })) {
        events.push(ev)
      }

      expect(call).toBe(2)
      expect(JSON.parse(sentRawBodies[0]).prompt_cache_key).toBe('route-key-1')
      expect('prompt_cache_key' in JSON.parse(sentRawBodies[1])).toBe(false)

      const snapshots = events.filter(e => e.type === 'wire_snapshot')
      expect(snapshots).toHaveLength(1)
      const snapshot = snapshots[0].snapshot
      // 缓存必须已随 body 剥离失效：快照哈希对应当次真实发送的字符串
      expect(snapshot.rawBodyHash).toBe(createHash('sha256').update(sentRawBodies[1], 'utf8').digest('hex'))
      expect(snapshot.rawBodyBytes).toBe(Buffer.byteLength(sentRawBodies[1], 'utf8'))
      expect(snapshot.exactBodyHash).toBe(
        createHash('sha256').update(sentRawBodies[1], 'utf8').digest('hex').slice(0, 16)
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
