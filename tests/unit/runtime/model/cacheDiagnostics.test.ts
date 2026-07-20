import { afterEach, describe, expect, it } from 'vitest'
import { CacheDiagnostics, type DiagnosticPersistState } from '../../../../src/runtime/model/cacheDiagnostics'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import { computeWireSnapshot, type WireSnapshot } from '../../../../src/runtime/model/requestFingerprint'
import type { ChatMessage, ToolDefinition } from '../../../../src/runtime/model/types'

const TOOLS: ToolDefinition[] = [
  { name: 'ls', description: '列出目录', parameters: { type: 'object' } },
  { name: 'read', description: '读取文件', parameters: { type: 'object' } }
]

function makeSnapshot(overrides: Partial<WireSnapshot> = {}): WireSnapshot {
  return {
    model: 'test-model',
    toolsHash: 'tools-hash-stable',
    semanticMessageHashes: ['h1', 'h2', 'h3'],
    exactBodyHash: 'exact-hash',
    ...overrides
  }
}

describe('CacheDiagnostics wire 级 first-diff', () => {
  it('首轮无上一轮快照时不告警', () => {
    const diag = new CacheDiagnostics()
    const result = diag.recordWireSnapshot(makeSnapshot())
    expect(result.cacheBreakDetected).toBe(false)
    expect(result.firstDiffIndex).toBeNull()
  })

  it('纯追加（前一次 messages 是后一次的前缀）不告警', () => {
    const diag = new CacheDiagnostics()
    diag.recordWireSnapshot(makeSnapshot({ semanticMessageHashes: ['h1', 'h2'] }))
    const result = diag.recordWireSnapshot(makeSnapshot({
      semanticMessageHashes: ['h1', 'h2', 'h3'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(false)
    expect(result.firstDiffIndex).toBeNull()
  })

  it('中段消息改写 → firstDiffIndex 指向正确位置', () => {
    const diag = new CacheDiagnostics()
    diag.recordWireSnapshot(makeSnapshot({ semanticMessageHashes: ['h1', 'h2', 'h3'] }))
    const result = diag.recordWireSnapshot(makeSnapshot({
      semanticMessageHashes: ['h1', 'h2_CHANGED', 'h3', 'h4'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.reason).toBe('prefix_diff_detected')
    expect(result.firstDiffIndex).toBe(1)
  })

  it('toolsHash 变化 → firstDiffIndex 为 0', () => {
    const diag = new CacheDiagnostics()
    diag.recordWireSnapshot(makeSnapshot({ toolsHash: 'tools-a' }))
    const result = diag.recordWireSnapshot(makeSnapshot({
      toolsHash: 'tools-b',
      semanticMessageHashes: ['h1', 'h2', 'h3', 'h4'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.firstDiffIndex).toBe(0)
  })

  it('model 变化 → firstDiffIndex 为 0', () => {
    const diag = new CacheDiagnostics()
    diag.recordWireSnapshot(makeSnapshot({ model: 'model-a' }))
    const result = diag.recordWireSnapshot(makeSnapshot({
      model: 'model-b',
      semanticMessageHashes: ['h1', 'h2', 'h3', 'h4'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.firstDiffIndex).toBe(0)
  })

  it('消息数缩短 → firstDiffIndex 指向缩短点', () => {
    const diag = new CacheDiagnostics()
    diag.recordWireSnapshot(makeSnapshot({ semanticMessageHashes: ['h1', 'h2', 'h3', 'h4', 'h5'] }))
    const result = diag.recordWireSnapshot(makeSnapshot({
      semanticMessageHashes: ['h1', 'h2'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.firstDiffIndex).toBe(2)
  })
})

describe('CacheDiagnostics epoch 管理', () => {
  it('bumpEpoch 后首轮不告警', () => {
    const diag = new CacheDiagnostics()
    diag.recordWireSnapshot(makeSnapshot({ semanticMessageHashes: ['h1', 'h2'] }))

    diag.bumpEpoch('compaction')
    const result = diag.recordWireSnapshot(makeSnapshot({
      semanticMessageHashes: ['completely', 'different'],
      exactBodyHash: 'exact-new'
    }))
    expect(result.cacheBreakDetected).toBe(false)
    expect(result.firstDiffIndex).toBeNull()
  })

  it('bumpEpoch 后第二轮恢复正常检测', () => {
    const diag = new CacheDiagnostics()
    diag.bumpEpoch('compaction')
    diag.recordWireSnapshot(makeSnapshot({ semanticMessageHashes: ['a1', 'a2'] }))

    const result = diag.recordWireSnapshot(makeSnapshot({
      semanticMessageHashes: ['a1_CHANGED', 'a2'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.firstDiffIndex).toBe(0)
  })

  it('各类 reason 触发后 epochId 变更', () => {
    const diag = new CacheDiagnostics()
    const id0 = diag.getEpochId()

    diag.bumpEpoch('compaction')
    const id1 = diag.getEpochId()
    expect(id1).not.toBe(id0)
    expect(diag.getEpochReason()).toBe('compaction')

    diag.bumpEpoch('model_switch')
    const id2 = diag.getEpochId()
    expect(id2).not.toBe(id1)
    expect(diag.getEpochReason()).toBe('model_switch')

    diag.bumpEpoch('toolset_change')
    expect(diag.getEpochId()).not.toBe(id2)
    expect(diag.getEpochReason()).toBe('toolset_change')
  })
})

describe('CacheDiagnostics cache_read 跌落检测', () => {
  it('首轮无历史不检测', () => {
    const diag = new CacheDiagnostics()
    const result = diag.checkCacheReadDrop(100)
    expect(result.cacheBreakDetected).toBe(false)
  })

  it('cache_read_tokens 显著下降时检测到破坏', () => {
    const diag = new CacheDiagnostics()
    diag.checkCacheReadDrop(10000)
    const result = diag.checkCacheReadDrop(5000)
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.reason).toBe('significant_cache_read_drop')
    expect(result.tokenDelta).toBe(-5000)
  })

  it('cache_read 小幅波动不误报', () => {
    const diag = new CacheDiagnostics()
    diag.checkCacheReadDrop(10000)
    const result = diag.checkCacheReadDrop(9800)
    expect(result.cacheBreakDetected).toBe(false)
  })

  it('bumpEpoch 后 lastCacheReadTokens 重置', () => {
    const diag = new CacheDiagnostics()
    diag.checkCacheReadDrop(10000)
    diag.bumpEpoch('compaction')
    const result = diag.checkCacheReadDrop(500)
    expect(result.cacheBreakDetected).toBe(false)
  })
})

describe('CacheDiagnostics 跨回合持久化', () => {
  it('getPersistState / restoreFromState 往返一致', () => {
    const diag1 = new CacheDiagnostics()
    diag1.recordWireSnapshot(makeSnapshot({ semanticMessageHashes: ['a', 'b'] }))
    diag1.checkCacheReadDrop(8000)

    const state = diag1.getPersistState()
    expect(state.epochId).toBe(diag1.getEpochId())
    expect(state.lastCacheReadTokens).toBe(8000)
    expect(state.lastSnapshot).not.toBeNull()

    const diag2 = new CacheDiagnostics()
    diag2.restoreFromState(state)
    expect(diag2.getEpochId()).toBe(diag1.getEpochId())

    // 恢复后纯追加不告警
    const result = diag2.recordWireSnapshot(makeSnapshot({
      semanticMessageHashes: ['a', 'b', 'c'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(false)
  })

  it('模拟 loop 重建后快照仍可读取比对', () => {
    const diag1 = new CacheDiagnostics()
    diag1.recordWireSnapshot(makeSnapshot({ semanticMessageHashes: ['x1', 'x2', 'x3'] }))
    const state = diag1.getPersistState()

    // 模拟 loop 重建
    const diag2 = new CacheDiagnostics()
    diag2.restoreFromState(state)

    // 中段改写 → 检出
    const result = diag2.recordWireSnapshot(makeSnapshot({
      semanticMessageHashes: ['x1', 'x2_MODIFIED', 'x3'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.firstDiffIndex).toBe(1)
  })

  it('持久化回调在每次快照更新后触发', () => {
    const diag = new CacheDiagnostics()
    const states: DiagnosticPersistState[] = []
    diag.setPersistCallback((s) => states.push(s))

    diag.recordWireSnapshot(makeSnapshot())
    diag.recordWireSnapshot(makeSnapshot({ semanticMessageHashes: ['a', 'b', 'c', 'd'], exactBodyHash: 'e2' }))

    expect(states).toHaveLength(2)
    expect(states[1].lastSnapshot).not.toBeNull()
  })
})

describe('CacheDiagnostics 隐私安全', () => {
  let originalFetch: typeof globalThis.fetch

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch
  })

  it('诊断结果与快照不含 prompt 正文 / API key / thinking', async () => {
    const sensitiveSystem =
      '你是编程助手。API_KEY=sk-secret-should-never-log。内部推理：先拆解问题…'
    const thinkingLeak = 'thinking: 用户想改缓存策略'

    originalFetch = globalThis.fetch
    let capturedBody: Record<string, unknown> | null = null
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string)
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
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

    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-secret-should-never-log',
      modelId: 'test-model',
      cacheStrategy: 'auto'
    })
    const messages: ChatMessage[] = [
      { role: 'system', content: sensitiveSystem },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: thinkingLeak }
    ]

    let snapshot: WireSnapshot | undefined
    for await (const ev of client.chat(messages, TOOLS)) {
      if (ev.type === 'wire_snapshot') snapshot = ev.snapshot
    }

    expect(capturedBody).not.toBeNull()
    expect(snapshot).toBeDefined()

    // 快照所有字段都是哈希，不含明文
    const snapshotJson = JSON.stringify(snapshot)
    expect(snapshotJson).not.toContain('sk-secret')
    expect(snapshotJson).not.toContain('内部推理')
    expect(snapshotJson).not.toContain('用户想改缓存策略')
    expect(snapshotJson).not.toContain(sensitiveSystem)
    expect(snapshotJson).not.toContain('hello')

    // 与直接对 body 计算一致
    const directSnapshot = computeWireSnapshot(capturedBody!, 'generic')
    expect(directSnapshot.exactBodyHash).toBe(snapshot!.exactBodyHash)
  })
})
