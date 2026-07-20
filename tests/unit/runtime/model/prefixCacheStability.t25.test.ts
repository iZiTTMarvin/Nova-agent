/**
 * T2-5：前缀缓存稳定性黑盒 + 预期变化不误报
 *
 * 本文件是「请求形状结构守卫」（mock fetch，验证连续请求的可复用前缀逐字节一致），
 * 不是 DeepSeek 服务端 KV cache 的真实命中率指标；真实命中率观测见 deepseekLiveProbe.test.ts。
 *
 * - 连续 N 轮相同 profile/工具时，可复用前缀（system + tools + 既有 messages）逐字节一致
 * - 动态 L2 不进 system 前缀
 * - 压缩 / 模型切换等预期变化经 bumpEpoch 后不误报
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import { computeWireSnapshot, type WireSnapshot } from '../../../../src/runtime/model/requestFingerprint'
import type { ChatMessage, ToolDefinition } from '../../../../src/runtime/model/types'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { buildStableSystemPrompt } from '../../../../src/runtime/agent/promptBuilder/modePrompt'
import { renderBaseRules } from '../../../../src/runtime/agent/promptRenderer'
import { extractTextFromContent } from '../../../../src/runtime/model/types'
import { L2_BLOCK_TITLE } from '../../../../src/runtime/memory/MemoryTailInjector'

const STABLE_TOOLS: ToolDefinition[] = [
  {
    name: 'ls',
    description: '列出目录',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  },
  {
    name: 'read',
    description: '读取文件',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'number' } },
      required: ['path']
    }
  }
]

function interceptFetchBodies(): {
  bodies: Array<Record<string, unknown>>
  restore: () => void
} {
  const originalFetch = globalThis.fetch
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string))
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n')
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
  return {
    bodies,
    restore: () => {
      globalThis.fetch = originalFetch
    }
  }
}

async function drain(
  client: OpenAICompatibleModelClient,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  options?: Parameters<OpenAICompatibleModelClient['chat']>[2]
): Promise<WireSnapshot | undefined> {
  let snapshot: WireSnapshot | undefined
  for await (const ev of client.chat(messages, tools, options)) {
    if (ev.type === 'wire_snapshot') snapshot = ev.snapshot
  }
  return snapshot
}

/** 可复用前缀：system + 除最后一条 user 外的历史 + tools 段 */
function reusablePrefixJson(body: Record<string, unknown>): string {
  const messages = body.messages as Array<Record<string, unknown>>
  const prefixMessages = messages.slice(0, -1)
  return JSON.stringify({
    messages: prefixMessages,
    tools: body.tools
  })
}

describe('T2-5 前缀稳定性黑盒', () => {
  let interceptor: ReturnType<typeof interceptFetchBodies> | null = null

  afterEach(() => {
    interceptor?.restore()
    interceptor = null
  })

  it('连续 N 轮相同 profile/工具：可复用前缀逐字节一致', async () => {
    interceptor = interceptFetchBodies()
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      modelId: 'deepseek-chat',
      cacheProfile: 'deepseek'
    })

    const history: ChatMessage[] = [{ role: 'system', content: '稳定 system 前缀' }]
    const snapshots: WireSnapshot[] = []

    for (let i = 0; i < 3; i++) {
      history.push({ role: 'user', content: `第 ${i + 1} 轮问题` })
      const snapshot = await drain(client, [...history], STABLE_TOOLS)
      expect(snapshot).toBeDefined()
      expect(snapshot!.exactBodyHash).toMatch(/^[a-f0-9]{16}$/)
      snapshots.push(snapshot!)
      history.push({ role: 'assistant', content: `第 ${i + 1} 轮回答` })
    }

    expect(interceptor.bodies).toHaveLength(3)
    const prefix1 = reusablePrefixJson(interceptor.bodies[0])
    const prefix2 = reusablePrefixJson(interceptor.bodies[1])
    const prefix3 = reusablePrefixJson(interceptor.bodies[2])

    // tools 段逐字节一致
    expect(JSON.stringify(interceptor.bodies[0].tools)).toBe(
      JSON.stringify(interceptor.bodies[1].tools)
    )
    expect(JSON.stringify(interceptor.bodies[1].tools)).toBe(
      JSON.stringify(interceptor.bodies[2].tools)
    )

    // system 消息逐字节一致
    const sys = (b: Record<string, unknown>) =>
      (b.messages as Array<Record<string, unknown>>)[0]
    expect(JSON.stringify(sys(interceptor.bodies[0]))).toBe(JSON.stringify(sys(interceptor.bodies[1])))
    expect(JSON.stringify(sys(interceptor.bodies[1]))).toBe(JSON.stringify(sys(interceptor.bodies[2])))

    // 轮次增长时，前一轮的 messages 前缀是后一轮的真前缀
    const msgs2 = interceptor.bodies[1].messages as unknown[]
    const msgs3 = interceptor.bodies[2].messages as unknown[]
    expect(JSON.stringify(msgs3.slice(0, msgs2.length - 1))).toBe(
      JSON.stringify(msgs2.slice(0, -1))
    )

    // 快照随历史增长而变化（消息数增加），但不得含明文
    expect(snapshots[0].exactBodyHash).not.toBe(snapshots[1].exactBodyHash)
    expect(snapshots.map(s => s.exactBodyHash).join('')).not.toContain('稳定 system')
    expect(prefix1).toContain('稳定 system')
    expect(prefix2.length).toBeGreaterThan(prefix1.length)
    expect(prefix3.length).toBeGreaterThan(prefix2.length)
  })

  it('动态 L2 不进入 system 前缀（与既有 prefix-cache-stability 对齐）', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: 'ok' }, { type: 'message_end', finishReason: 'stop' }]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: 'ok' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const L1 = '用户偏好：中文注释'
    const loop = new AgentLoop(client, new EventBus(), {
      systemPromptLayers: {
        agentRole: buildStableSystemPrompt({ workingDir: '/tmp/project' }),
        baseRules: renderBaseRules(),
        projectRules: '',
        memoryContext: L1,
        skillContext: '',
        toolSummary: ''
      }
    })

    await loop.sendMessage('第一问')
    await loop.sendMessage('第二问')

    const calls = client.getCalls()
    expect(calls).toHaveLength(2)
    const sysA = extractTextFromContent(calls[0].messages.find(m => m.role === 'system')!.content)
    const sysB = extractTextFromContent(calls[1].messages.find(m => m.role === 'system')!.content)
    expect(sysB).toBe(sysA)
    expect(sysA).toContain(L1)
    expect(sysA).not.toContain(L2_BLOCK_TITLE)
    for (const call of calls) {
      const texts = call.messages.map(m => extractTextFromContent(m.content))
      expect(texts.some(t => t.includes(L2_BLOCK_TITLE))).toBe(false)
    }
  })

  it('预期变化不误报：压缩 bumpEpoch / 模型切换后首轮不告警', () => {
    const diag = new CacheDiagnostics()

    const snapshot1: WireSnapshot = {
      model: 'm',
      toolsHash: 'th1',
      semanticMessageHashes: ['h1', 'h2', 'h3'],
      exactBodyHash: 'e1'
    }
    const snapshot2: WireSnapshot = {
      model: 'm',
      toolsHash: 'th1',
      semanticMessageHashes: ['h1', 'h2', 'h3', 'h4'],
      exactBodyHash: 'e2'
    }

    // 稳定轮：纯追加不告警
    diag.recordWireSnapshot(snapshot1)
    const r2 = diag.recordWireSnapshot(snapshot2)
    expect(r2.cacheBreakDetected).toBe(false)

    // 压缩：bumpEpoch 后首轮不告警
    diag.bumpEpoch('compaction')
    const afterCompact: WireSnapshot = {
      model: 'm',
      toolsHash: 'th1',
      semanticMessageHashes: ['new1', 'new2'],
      exactBodyHash: 'e3'
    }
    const r3 = diag.recordWireSnapshot(afterCompact)
    expect(r3.cacheBreakDetected).toBe(false)

    // 模型切换：bumpEpoch 后首轮不告警
    diag.bumpEpoch('model_switch')
    const afterSwitch: WireSnapshot = {
      model: 'm2',
      toolsHash: 'th2',
      semanticMessageHashes: ['x1'],
      exactBodyHash: 'e4'
    }
    const r4 = diag.recordWireSnapshot(afterSwitch)
    expect(r4.cacheBreakDetected).toBe(false)
  })

  it('wireSnapshot 接线：最终 body 快照可被 CacheDiagnostics 记录且无明文', async () => {
    interceptor = interceptFetchBodies()
    const client = new OpenAICompatibleModelClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-secret-never-log',
      modelId: 'test-model',
      cacheProfile: 'generic'
    })
    const diag = new CacheDiagnostics()
    const messages: ChatMessage[] = [
      { role: 'system', content: '秘密 system 正文' },
      { role: 'user', content: 'hello' }
    ]

    let yieldedSnapshot: WireSnapshot | undefined
    for await (const ev of client.chat(messages, STABLE_TOOLS)) {
      if (ev.type === 'wire_snapshot') {
        yieldedSnapshot = ev.snapshot
        diag.recordWireSnapshot(ev.snapshot)
      }
    }

    expect(yieldedSnapshot).toBeDefined()
    expect(yieldedSnapshot!.exactBodyHash).toMatch(/^[a-f0-9]{16}$/)
    expect(diag.getLastWireSnapshot()).toBe(yieldedSnapshot)
    expect(yieldedSnapshot!.exactBodyHash).not.toContain('秘密')
    expect(yieldedSnapshot!.exactBodyHash).not.toContain('sk-')
    // 与直接对 body 计算一致
    const directSnapshot = computeWireSnapshot(interceptor.bodies[0], 'generic')
    expect(directSnapshot.exactBodyHash).toBe(yieldedSnapshot!.exactBodyHash)
  })
})
