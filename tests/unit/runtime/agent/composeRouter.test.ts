import { describe, expect, it, vi, afterEach } from 'vitest'
import { routeComposeInput } from '../../../../src/runtime/agent/composeRouter'
import type { ModelClient } from '../../../../src/runtime/model/ModelClient'
import type { ChatEvent } from '../../../../src/runtime/model/types'

/** 构造返回固定文本的 mock ModelClient */
function mockModelClient(text: string): ModelClient {
  return {
    async *chat() {
      yield { type: 'text_delta', delta: text } as ChatEvent
      yield { type: 'message_end', finishReason: 'stop' } as ChatEvent
    },
    updateConfig() {}
  }
}

/** 构造发出 error 事件的 mock ModelClient */
function mockErrorClient(error: string): ModelClient {
  return {
    async *chat() {
      yield { type: 'error', error } as ChatEvent
    },
    updateConfig() {}
  }
}

/** 永不 yield 的挂起 mock，用于超时测试 */
function mockHangingClient(): ModelClient {
  return {
    async *chat() {
      // 故意不 yield，让 for-await 一直等待首个事件
      await new Promise<void>(() => { /* 永不 resolve */ })
    },
    updateConfig() {}
  }
}

describe('routeComposeInput', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("route='full'：解析明确开发需求", async () => {
    const client = mockModelClient('{"route":"full","reason":"明确开发需求"}')
    const result = await routeComposeInput('实现登录功能', client)
    expect(result.route).toBe('full')
    expect(result.reason).toBe('明确开发需求')
  })

  it("route='plan'：解析设计规划类输入", async () => {
    const client = mockModelClient('{"route":"plan","reason":"需要先设计方案"}')
    const result = await routeComposeInput('帮我设计登录模块架构', client)
    expect(result.route).toBe('plan')
    expect(result.reason).toBe('需要先设计方案')
  })

  it("route='quick'：解析单点改动类输入", async () => {
    const client = mockModelClient('{"route":"quick","reason":"单点答疑"}')
    const result = await routeComposeInput('改个文案', client)
    expect(result.route).toBe('quick')
    expect(result.reason).toBe('单点答疑')
  })

  it('非法 JSON 降级为 quick', async () => {
    const client = mockModelClient('这不是 JSON')
    const result = await routeComposeInput('随便问问', client)
    expect(result.route).toBe('quick')
    expect(result.reason).toContain('降级')
  })

  it('route 值非法降级为 quick', async () => {
    const client = mockModelClient('{"route":"unknown","reason":"无效"}')
    const result = await routeComposeInput('测试', client)
    expect(result.route).toBe('quick')
    expect(result.reason).toContain('降级')
  })

  it('模型 error 事件降级为 quick', async () => {
    const client = mockErrorClient('upstream failed')
    const result = await routeComposeInput('测试', client)
    expect(result.route).toBe('quick')
    expect(result.reason).toBe('router 调用失败降级')
  })

  it('8s 超时降级为 quick（fake timers + Promise.race）', async () => {
    vi.useFakeTimers()
    const client = mockHangingClient()
    const promise = routeComposeInput('挂起输入', client)
    await vi.advanceTimersByTimeAsync(8000)
    const result = await promise
    expect(result.route).toBe('quick')
    expect(result.reason).toBe('router 超时降级')
  })

  it('支持 ```json 围栏解析', async () => {
    const client = mockModelClient('```json\n{"route":"plan","reason":"围栏"}\n```')
    const result = await routeComposeInput('调研技术方案', client)
    expect(result.route).toBe('plan')
    expect(result.reason).toBe('围栏')
  })
})
