/**
 * T1-3：usage 事件必须携带实际 active provider 的 cacheProfileId。
 * fallback 切换后归属新 provider，不能沿用主模型档案。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { ModelClientPool } from '../../../../src/runtime/model/ModelClientPool'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import type { ChatEvent, NormalizedUsage } from '../../../../src/runtime/model/types'
import type { AgentEvent } from '../../../../src/runtime/agent/types'

const loops: AgentLoop[] = []

afterEach(() => {
  for (const loop of loops.splice(0)) {
    loop.dispose()
  }
  vi.useRealTimers()
})

function usageEvent(prompt = 100): ChatEvent {
  return {
    type: 'usage',
    usage: {
      promptTokens: prompt,
      completionTokens: 10,
      cachedTokens: 0,
      cacheWriteTokens: 0
    } satisfies NormalizedUsage
  }
}

async function isSettled(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    p.then(
      () => true,
      () => true
    ),
    Promise.resolve(false)
  ])
}

async function runDrained(loop: AgentLoop, eventBus: EventBus, text: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  eventBus.on(e => events.push(e))
  const pending = loop.sendMessage(text)
  for (let i = 0; i < 200; i++) {
    await vi.advanceTimersByTimeAsync(1000)
    if (await isSettled(pending)) break
  }
  await pending
  return events
}

describe('usage 事件 cacheProfileId', () => {
  it('主模型 usage 携带 resolveCacheProfile 得到的 profileId', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'ok' },
        usageEvent(120),
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const pool = new ModelClientPool({
      primary: client,
      primaryConfig: {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'test',
        modelId: 'deepseek-chat'
      }
    })
    const eventBus = new EventBus()
    const loop = new AgentLoop(pool, eventBus, {})
    loops.push(loop)

    const events: AgentEvent[] = []
    eventBus.on(e => events.push(e))
    await loop.sendMessage('hi')

    const usage = events.find(e => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>
    expect(usage).toBeDefined()
    expect(usage.cacheProfileId).toBe('deepseek')
    expect(usage.usage.promptTokens).toBe(120)
  })

  it('fallback 切换后 usage 归属新 provider 的 profileId', async () => {
    vi.useFakeTimers()
    const primary = new MockModelClient()
    primary.addResponse({ events: [{ type: 'error', error: '429 rate limit' }] })
    primary.addResponse({ events: [{ type: 'error', error: '429 rate limit' }] })
    primary.addResponse({ events: [{ type: 'error', error: '429 rate limit' }] })

    const fallback = new MockModelClient()
    fallback.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'fallback ok' },
        usageEvent(70),
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const pool = new ModelClientPool({
      primary: primary,
      primaryConfig: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test',
        modelId: 'gpt-4o'
      },
      fallbacks: [
        {
          config: {
            baseUrl: 'https://api.moonshot.cn/v1',
            apiKey: 'test',
            modelId: 'moonshot-v1-auto'
          },
          client: fallback
        }
      ]
    })
    const eventBus = new EventBus()
    const loop = new AgentLoop(pool, eventBus, {})
    loops.push(loop)

    const events = await runDrained(loop, eventBus, 'hi')
    expect(events.some(e => e.type === 'model_switched')).toBe(true)

    const usageEvents = events.filter(e => e.type === 'usage') as Array<
      Extract<AgentEvent, { type: 'usage' }>
    >
    expect(usageEvents.length).toBeGreaterThanOrEqual(1)
    // 成功完成的 usage 必须来自 fallback（kimi），不能仍是 openai
    const lastUsage = usageEvents[usageEvents.length - 1]
    expect(lastUsage.cacheProfileId).toBe('kimi')
  })

  it('显式 cacheProfile 覆盖优先于 URL 自动判定', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: 'ok' },
        usageEvent(50),
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const pool = new ModelClientPool({
      primary: client,
      primaryConfig: {
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'test',
        modelId: 'custom-model',
        cacheProfile: 'glm'
      }
    })
    const eventBus = new EventBus()
    const loop = new AgentLoop(pool, eventBus, {})
    loops.push(loop)

    const events: AgentEvent[] = []
    eventBus.on(e => events.push(e))
    await loop.sendMessage('hi')

    const usage = events.find(e => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>
    expect(usage.cacheProfileId).toBe('glm')
  })
})
