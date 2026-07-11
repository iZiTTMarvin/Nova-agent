/**
 * T2-5：前缀缓存稳定性黑盒 + 预期变化不误报
 *
 * 本文件是「请求形状结构守卫」（mock fetch，验证连续请求的可复用前缀逐字节一致），
 * 不是 DeepSeek 服务端 KV cache 的真实命中率指标；真实命中率观测见 deepseekLiveProbe.test.ts。
 *
 * - 连续 N 轮相同 profile/工具时，可复用前缀（system + tools + 既有 messages）逐字节一致
 * - 动态 L2 不进 system 前缀
 * - 压缩 / L1 更新 / 模型切换等预期变化经 resetBaseline 后不误报
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import { fingerprintFinalRequestBody } from '../../../../src/runtime/model/requestFingerprint'
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
): Promise<string | undefined> {
  let fp: string | undefined
  for await (const ev of client.chat(messages, tools, options)) {
    if (ev.type === 'request_fingerprint') fp = ev.fingerprint
  }
  return fp
}

/** 可复用前缀：system + 除最后一条 user 外的历史 + tools 段 */
function reusablePrefixJson(body: Record<string, unknown>): string {
  const messages = body.messages as Array<Record<string, unknown>>
  // 去掉最后一条（本轮新 user），保留可复用前缀
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
    const fps: string[] = []

    for (let i = 0; i < 3; i++) {
      history.push({ role: 'user', content: `第 ${i + 1} 轮问题` })
      const fp = await drain(client, [...history], STABLE_TOOLS)
      expect(fp).toMatch(/^[a-f0-9]{16}$/)
      fps.push(fp!)
      history.push({ role: 'assistant', content: `第 ${i + 1} 轮回答` })
    }

    expect(interceptor.bodies).toHaveLength(3)
    // 第 2、3 轮的可复用前缀应包含第 1 轮的完整前缀（system + tools 不变）
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

    // 指纹随历史增长而变化（内容长度变了），但不得含明文
    expect(fps[0]).not.toBe(fps[1])
    expect(fps.join('')).not.toContain('稳定 system')
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

  it('预期变化不误报：压缩 resetBaseline / L1 更新后重建基线 / 模型切换', () => {
    const diag = new CacheDiagnostics()
    const tools = STABLE_TOOLS

    // 稳定轮
    diag.recordBaseline('sys-v1', tools)
    expect(diag.checkResponse(8000, 'sys-v1', tools).cacheBreakDetected).toBe(false)

    // 压缩：resetBaseline 后用新 system（含摘要）不误报
    const afterCompact = 'sys-v1\n\n[对话历史摘要]\n旧对话摘要'
    diag.resetBaseline(afterCompact, tools)
    expect(diag.checkResponse(500, afterCompact, tools).cacheBreakDetected).toBe(false)

    // L1 / 项目规则明确更新：先 recordBaseline 新值，再 check 同值 → 不误报
    const withL1 = afterCompact + '\n=== Project Memory ===\n新规则'
    diag.recordBaseline(withL1, tools)
    expect(diag.checkResponse(600, withL1, tools).cacheBreakDetected).toBe(false)

    // 模型切换：新工具集作为新基线，同基线不误报
    const toolsAfterSwitch: ToolDefinition[] = [
      ...tools,
      { name: 'bash', description: 'shell', parameters: { type: 'object' } }
    ]
    diag.resetBaseline(withL1, toolsAfterSwitch)
    expect(diag.checkResponse(400, withL1, toolsAfterSwitch).cacheBreakDetected).toBe(false)

    // 跨日 session context 在 user 侧：system 不变 → 不误报
    diag.recordBaseline(withL1, toolsAfterSwitch)
    diag.checkResponse(1000, withL1, toolsAfterSwitch)
    expect(diag.checkResponse(1100, withL1, toolsAfterSwitch).cacheBreakDetected).toBe(false)
  })

  it('requestFingerprint 接线：最终 body 指纹可被 CacheDiagnostics 记录且无明文', async () => {
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

    let yieldedFp: string | undefined
    for await (const ev of client.chat(messages, STABLE_TOOLS)) {
      if (ev.type === 'request_fingerprint') {
        yieldedFp = ev.fingerprint
        diag.recordRequestFingerprint(ev.fingerprint)
      }
    }

    expect(yieldedFp).toMatch(/^[a-f0-9]{16}$/)
    expect(diag.getLastRequestFingerprint()).toBe(yieldedFp)
    expect(yieldedFp).not.toContain('秘密')
    expect(yieldedFp).not.toContain('sk-')
    // 与直接对 body 计算一致
    expect(fingerprintFinalRequestBody(interceptor.bodies[0])).toBe(yieldedFp)
  })
})
