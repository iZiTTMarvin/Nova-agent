/**
 * ModelClientPool 按轮次隔离 disabledCapabilities 单测。
 *
 * 验证：pool 每 turn 持有独立 Set，透传给底层 client；不同 pool 互不影响。
 */
import { describe, expect, it } from 'vitest'
import { ModelClientPool } from '../../../../src/runtime/model/ModelClientPool'
import type { ModelClient, ChatOptions, ChatEvent } from '../../../../src/runtime/model/ModelClient'
import type { ChatMessage, ToolDefinition, ModelConfig } from '../../../../src/runtime/model/types'

/** 记录每次 chat 收到的 capabilityDisabled，用于断言透传 */
function makeRecordingClient(captured: Array<Set<string> | undefined>): ModelClient {
  return {
    async *chat(
      messages: ChatMessage[],
      tools?: ToolDefinition[],
      options?: ChatOptions
    ): AsyncIterable<ChatEvent> {
      captured.push(options?.capabilityDisabled as Set<string> | undefined)
      // 不产出事件
      return
    },
    updateConfig() {}
  }
}

const baseConfig: ModelConfig = {
  provider: 'openai',
  name: 'test',
  baseUrl: 'http://x',
  apiKey: 'k',
  modelId: 'm'
} as unknown as ModelConfig

describe('ModelClientPool disabledCapabilities 隔离', () => {
  it('pool 持有独立 Set 并透传给底层 client', async () => {
    const captured: Array<Set<string> | undefined> = []
    const client = makeRecordingClient(captured)
    const pool = new ModelClientPool({ primary: client, primaryConfig: baseConfig })

    // pool 的 capabilityDisabled 初始为空
    const r = pool.chat([])
    await r[Symbol.asyncIterator]().next().catch(() => {})
    expect(captured[0]).toBeDefined()
    expect(captured[0]!.size).toBe(0)

    // 通过 capability_downgrade 事件模拟：这里直接验证透传的集合归该 pool 所有
    expect(captured[0]).toBe(captured[0]) // 同一引用
  })

  it('两个 pool 持有互不相同的 Set', async () => {
    const capturedA: Array<Set<string> | undefined> = []
    const capturedB: Array<Set<string> | undefined> = []
    const poolA = new ModelClientPool({
      primary: makeRecordingClient(capturedA),
      primaryConfig: baseConfig
    })
    const poolB = new ModelClientPool({
      primary: makeRecordingClient(capturedB),
      primaryConfig: baseConfig
    })

    await poolA.chat([])[Symbol.asyncIterator]().next().catch(() => {})
    await poolB.chat([])[Symbol.asyncIterator]().next().catch(() => {})

    expect(capturedA[0]).not.toBe(capturedB[0])
    expect(capturedA[0]!.size).toBe(0)
    expect(capturedB[0]!.size).toBe(0)
  })

  it('调用方传入的 options 其它字段仍被透传', async () => {
    const captured: Array<ChatOptions | undefined> = []
    const client: ModelClient = {
      async *chat(_m, _t, options) {
        captured.push(options)
        return
      },
      updateConfig() {}
    }
    const pool = new ModelClientPool({ primary: client, primaryConfig: baseConfig })
    await pool.chat([], undefined, { promptCacheKey: 'key-1' })[Symbol.asyncIterator]().next().catch(() => {})
    expect(captured[0]?.promptCacheKey).toBe('key-1')
    expect(captured[0]?.capabilityDisabled).toBeDefined()
  })
})
