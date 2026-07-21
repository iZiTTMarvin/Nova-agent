import { afterEach, describe, expect, it } from 'vitest'
import { CacheDiagnostics, type DiagnosticPersistState } from '../../../../src/runtime/model/cacheDiagnostics'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import {
  computeWireSnapshot,
  type WireSnapshot,
  type MessageSegmentFingerprint
} from '../../../../src/runtime/model/requestFingerprint'
import type { ChatMessage, ToolDefinition } from '../../../../src/runtime/model/types'
import { createHash } from 'crypto'

const TOOLS: ToolDefinition[] = [
  { name: 'ls', description: '列出目录', parameters: { type: 'object' } },
  { name: 'read', description: '读取文件', parameters: { type: 'object' } }
]

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function seg(
  wholeKey: string,
  overrides: Partial<MessageSegmentFingerprint> = {}
): MessageSegmentFingerprint {
  return {
    whole: hash(wholeKey),
    role: hash('assistant'),
    content: hash(`content:${wholeKey}`),
    reasoningContent: hash(`reasoning:${wholeKey}`),
    toolCalls: hash('null'),
    toolResult: hash(''),
    bytes: 100 + wholeKey.length * 10,
    ...overrides
  }
}

function makeSnapshot(overrides: Partial<WireSnapshot> & {
  messageKeys?: string[]
} = {}): WireSnapshot {
  const { messageKeys, messages, ...rest } = overrides
  const keys = messageKeys ?? ['h1', 'h2', 'h3']
  const msgs = messages ?? keys.map(k => seg(k))
  return {
    model: 'test-model',
    toolsHash: 'tools-hash-stable',
    toolsBytes: 200,
    messages: msgs,
    exactBodyHash: 'exact-hash',
    bodyBytes: msgs.reduce((s, m) => s + m.bytes, 200),
    ...rest
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
    diag.recordWireSnapshot(makeSnapshot({ messageKeys: ['h1', 'h2'] }))
    const result = diag.recordWireSnapshot(makeSnapshot({
      messageKeys: ['h1', 'h2', 'h3'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(false)
    expect(result.firstDiffIndex).toBeNull()
  })

  it('中段消息改写 → firstDiffIndex 指向正确位置', () => {
    const diag = new CacheDiagnostics()
    diag.recordWireSnapshot(makeSnapshot({ messageKeys: ['h1', 'h2', 'h3'] }))
    const result = diag.recordWireSnapshot(makeSnapshot({
      messageKeys: ['h1', 'h2_CHANGED', 'h3', 'h4'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.reason).toBe('prefix_diff_detected')
    expect(result.firstDiffIndex).toBe(1)
  })

  it('中段 content 改写 → firstDiffPart=content，作废量级正确', () => {
    const diag = new CacheDiagnostics()
    const prev = makeSnapshot({
      messages: [
        seg('a', { bytes: 400 }),
        seg('b', {
          bytes: 800,
          content: hash('content-old'),
          whole: hash('b-old')
        }),
        seg('c', { bytes: 1200 })
      ]
    })
    diag.recordWireSnapshot(prev)

    const next = makeSnapshot({
      exactBodyHash: 'exact-2',
      messages: [
        seg('a', { bytes: 400 }),
        seg('b', {
          bytes: 800,
          content: hash('content-new'),
          whole: hash('b-new'),
          role: hash('assistant'),
          reasoningContent: hash('reasoning:b'),
          toolCalls: hash('null'),
          toolResult: hash('')
        }),
        seg('c', { bytes: 1200 }),
        seg('d', { bytes: 100 })
      ]
    })
    // 保持 role/reasoning 等同，仅 content/whole 变
    next.messages[1] = {
      ...prev.messages[1],
      content: hash('content-new'),
      whole: hash('b-new')
    }

    const result = diag.recordWireSnapshot(next)
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.firstDiffIndex).toBe(1)
    expect(result.firstDiffPart).toBe('content')
    expect(result.prefixDiff?.commonPrefixBytes).toBe(400)
    expect(result.prefixDiff?.invalidatedSuffixBytes).toBe(800 + 1200)
    expect(result.prefixDiff?.estimatedInvalidatedTokens).toBe(Math.ceil(2000 / 4))
  })

  it('toolsHash 变化 → firstDiffIndex 为 0，firstDiffPart=tools', () => {
    const diag = new CacheDiagnostics()
    diag.recordWireSnapshot(makeSnapshot({ toolsHash: 'tools-a' }))
    const result = diag.recordWireSnapshot(makeSnapshot({
      toolsHash: 'tools-b',
      messageKeys: ['h1', 'h2', 'h3', 'h4'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.firstDiffIndex).toBe(0)
    expect(result.firstDiffPart).toBe('tools')
  })

  it('model 变化 → firstDiffIndex 为 0，firstDiffPart=model', () => {
    const diag = new CacheDiagnostics()
    diag.recordWireSnapshot(makeSnapshot({ model: 'model-a' }))
    const result = diag.recordWireSnapshot(makeSnapshot({
      model: 'model-b',
      messageKeys: ['h1', 'h2', 'h3', 'h4'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.firstDiffIndex).toBe(0)
    expect(result.firstDiffPart).toBe('model')
  })

  it('消息数缩短 → firstDiffIndex 指向缩短点', () => {
    const diag = new CacheDiagnostics()
    diag.recordWireSnapshot(makeSnapshot({ messageKeys: ['h1', 'h2', 'h3', 'h4', 'h5'] }))
    const result = diag.recordWireSnapshot(makeSnapshot({
      messageKeys: ['h1', 'h2'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.firstDiffIndex).toBe(2)
  })

  it('expectedMiss 不告警', () => {
    const diag = new CacheDiagnostics()
    diag.recordWireSnapshot(makeSnapshot({ messageKeys: ['h1', 'h2'] }))
    const result = diag.recordWireSnapshot(
      makeSnapshot({ messageKeys: ['totally', 'different'], exactBodyHash: 'x' }),
      { expectedMiss: true }
    )
    expect(result.cacheBreakDetected).toBe(false)
    expect(result.prefixDiff?.expectedMiss).toBe(true)
  })
})

describe('CacheDiagnostics epoch 管理', () => {
  it('bumpEpoch 后首轮不告警', () => {
    const diag = new CacheDiagnostics()
    diag.recordWireSnapshot(makeSnapshot({ messageKeys: ['h1', 'h2'] }))

    diag.bumpEpoch('compaction')
    const result = diag.recordWireSnapshot(makeSnapshot({
      messageKeys: ['completely', 'different'],
      exactBodyHash: 'exact-new'
    }))
    expect(result.cacheBreakDetected).toBe(false)
    expect(result.firstDiffIndex).toBeNull()
  })

  it('bumpEpoch 后第二轮恢复正常检测', () => {
    const diag = new CacheDiagnostics()
    diag.bumpEpoch('compaction')
    diag.recordWireSnapshot(makeSnapshot({ messageKeys: ['a1', 'a2'] }))

    const result = diag.recordWireSnapshot(makeSnapshot({
      messageKeys: ['a1_CHANGED', 'a2'],
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
    diag1.recordWireSnapshot(makeSnapshot({ messageKeys: ['a', 'b'] }))
    diag1.checkCacheReadDrop(8000)

    const state = diag1.getPersistState()
    expect(state.epochId).toBe(diag1.getEpochId())
    expect(state.lastCacheReadTokens).toBe(8000)
    expect(state.lastSnapshot).not.toBeNull()

    const diag2 = new CacheDiagnostics()
    diag2.restoreFromState(state)
    expect(diag2.getEpochId()).toBe(diag1.getEpochId())

    const result = diag2.recordWireSnapshot(makeSnapshot({
      messageKeys: ['a', 'b', 'c'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(false)
  })

  it('模拟 loop 重建后快照仍可读取比对', () => {
    const diag1 = new CacheDiagnostics()
    diag1.recordWireSnapshot(makeSnapshot({ messageKeys: ['x1', 'x2', 'x3'] }))
    const state = diag1.getPersistState()

    const diag2 = new CacheDiagnostics()
    diag2.restoreFromState(state)

    const result = diag2.recordWireSnapshot(makeSnapshot({
      messageKeys: ['x1', 'x2_MODIFIED', 'x3'],
      exactBodyHash: 'exact-2'
    }))
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.firstDiffIndex).toBe(1)
  })

  it('兼容旧版 semanticMessageHashes 持久化快照', () => {
    const diag = new CacheDiagnostics()
    const legacyState: DiagnosticPersistState = {
      epochId: 'epoch_2',
      epochReason: 'compaction',
      lastCacheReadTokens: 100,
      lastSnapshot: {
        model: 'm',
        toolsHash: 't',
        semanticMessageHashes: [hash('a'), hash('b')],
        exactBodyHash: 'e'
      } as unknown as WireSnapshot
    }
    diag.restoreFromState(legacyState)
    const result = diag.recordWireSnapshot(makeSnapshot({
      model: 'm',
      toolsHash: 't',
      messages: [
        { ...seg('a'), whole: hash('a') },
        { ...seg('b'), whole: hash('b') },
        seg('c')
      ],
      exactBodyHash: 'e2'
    }))
    expect(result.cacheBreakDetected).toBe(false)
  })

  it('持久化回调在每次快照更新后触发', () => {
    const diag = new CacheDiagnostics()
    const states: DiagnosticPersistState[] = []
    diag.setPersistCallback((s) => states.push(s))

    diag.recordWireSnapshot(makeSnapshot())
    diag.recordWireSnapshot(makeSnapshot({ messageKeys: ['a', 'b', 'c', 'd'], exactBodyHash: 'e2' }))

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

    const snapshotJson = JSON.stringify(snapshot)
    expect(snapshotJson).not.toContain('sk-secret')
    expect(snapshotJson).not.toContain('内部推理')
    expect(snapshotJson).not.toContain('用户想改缓存策略')
    expect(snapshotJson).not.toContain(sensitiveSystem)
    expect(snapshotJson).not.toContain('hello')

    const directSnapshot = computeWireSnapshot(capturedBody!, 'generic')
    expect(directSnapshot.exactBodyHash).toBe(snapshot!.exactBodyHash)
  })
})
