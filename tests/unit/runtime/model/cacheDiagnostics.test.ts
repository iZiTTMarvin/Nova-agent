import { createHash } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import type { ChatMessage, ToolDefinition } from '../../../../src/runtime/model/types'

const SYSTEM_PROMPT = '你是编程助手'
const TOOLS: ToolDefinition[] = [
  { name: 'ls', description: '列出目录', parameters: { type: 'object' } },
  { name: 'read', description: '读取文件', parameters: { type: 'object' } }
]

/**
 * 基于最终 API 请求体结构的匿名指纹（T0-3 / 约束 5）。
 * 只纳入角色序列、工具名序、字段存在性、内容长度——不含 prompt 正文、API key、thinking。
 * 供后续 T1 会话级诊断对齐；当前 CacheDiagnostics 仍只用 system+tools 哈希。
 */
function fingerprintFinalRequestBody(body: Record<string, unknown>): string {
  const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? []
  const tools = (body.tools as Array<Record<string, unknown>> | undefined) ?? []

  const structural = {
    model: typeof body.model === 'string' ? body.model : '',
    messageRoles: messages.map(m => String(m.role ?? '')),
    messageContentLens: messages.map(m => {
      const c = m.content
      if (typeof c === 'string') return c.length
      if (Array.isArray(c)) return JSON.stringify(c).length
      return 0
    }),
    hasToolCalls: messages.map(m => Array.isArray(m.tool_calls) && m.tool_calls.length > 0),
    toolNames: tools.map(t => {
      const fn = t.function as { name?: string } | undefined
      return fn?.name ?? ''
    }),
    hasPromptCacheKey: 'prompt_cache_key' in body,
    hasCacheControlSomewhere: JSON.stringify(body).includes('"cache_control"')
  }

  // 防御：指纹输入不得携带敏感明文
  const raw = JSON.stringify(structural)
  expect(raw).not.toContain('sk-')
  expect(raw).not.toMatch(/你是编程助手|内部推理|thinking|apiKey|Authorization/i)

  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/** 模拟 agentHandler：每次 SEND_MESSAGE dispose 旧 loop 后 new 新的（诊断实例随之丢弃） */
function simulateSendMessageDisposeNew(): {
  dispose: () => void
  getDiag: () => CacheDiagnostics
} {
  let diag = new CacheDiagnostics()
  return {
    dispose: () => {
      // AgentLoop.dispose 不持久化 cacheDiagnostics；此处直接丢弃实例
      diag = new CacheDiagnostics()
    },
    getDiag: () => diag
  }
}

describe('CacheDiagnostics 缓存破坏检测', () => {
  it('首轮无基线时不检测', () => {
    const diag = new CacheDiagnostics()
    const result = diag.checkResponse(100, SYSTEM_PROMPT, TOOLS)
    expect(result.cacheBreakDetected).toBe(false)
  })

  it('记录基线后正常轮次不误报', () => {
    const diag = new CacheDiagnostics()
    diag.recordBaseline(SYSTEM_PROMPT, TOOLS)

    // 第一轮响应（无上轮数据，不检查下降）
    const r1 = diag.checkResponse(500, SYSTEM_PROMPT, TOOLS)
    expect(r1.cacheBreakDetected).toBe(false)

    // 第二轮响应（cache_read 上升或持平）
    const r2 = diag.checkResponse(600, SYSTEM_PROMPT, TOOLS)
    expect(r2.cacheBreakDetected).toBe(false)
  })

  it('system prompt 变化时检测到破坏', () => {
    const diag = new CacheDiagnostics()
    diag.recordBaseline(SYSTEM_PROMPT, TOOLS)
    diag.checkResponse(500, SYSTEM_PROMPT, TOOLS)

    // 模拟 system prompt 被意外修改
    const result = diag.checkResponse(100, '你是翻译助手', TOOLS)
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.reason).toBe('system_prompt_changed')
    expect(result.suggestion).toContain('系统提示')
  })

  it('工具定义变化时检测到破坏', () => {
    const diag = new CacheDiagnostics()
    diag.recordBaseline(SYSTEM_PROMPT, TOOLS)
    diag.checkResponse(500, SYSTEM_PROMPT, TOOLS)

    // 模拟工具定义被修改
    const changedTools: ToolDefinition[] = [
      { name: 'ls', description: '列出目录（修改）', parameters: { type: 'object' } },
      { name: 'read', description: '读取文件', parameters: { type: 'object' } }
    ]

    const result = diag.checkResponse(100, SYSTEM_PROMPT, changedTools)
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.reason).toBe('tool_schema_changed')
  })

  it('cache_read_tokens 显著下降时检测到破坏', () => {
    const diag = new CacheDiagnostics()
    diag.recordBaseline(SYSTEM_PROMPT, TOOLS)

    // 第一轮：大量缓存命中
    diag.checkResponse(10000, SYSTEM_PROMPT, TOOLS)

    // 第二轮：缓存大幅下降（>5% 且 >500 tokens）
    const result = diag.checkResponse(5000, SYSTEM_PROMPT, TOOLS)
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.reason).toBe('significant_cache_read_drop')
    expect(result.tokenDelta).toBe(-5000)
  })

  it('cache_read 小幅波动不误报', () => {
    const diag = new CacheDiagnostics()
    diag.recordBaseline(SYSTEM_PROMPT, TOOLS)
    diag.checkResponse(10000, SYSTEM_PROMPT, TOOLS)

    // 小幅下降（2%，200 tokens）不触发
    const result = diag.checkResponse(9800, SYSTEM_PROMPT, TOOLS)
    expect(result.cacheBreakDetected).toBe(false)
  })

  it('resetBaseline 后旧基线失效', () => {
    const diag = new CacheDiagnostics()
    diag.recordBaseline(SYSTEM_PROMPT, TOOLS)
    diag.checkResponse(10000, SYSTEM_PROMPT, TOOLS)

    // 模拟压缩后重置基线
    const newSystemPrompt = `${SYSTEM_PROMPT}\n\n[对话历史摘要]\n摘要内容`
    diag.resetBaseline(newSystemPrompt, TOOLS)

    // 新基线下使用新 system prompt 不应报错
    const result = diag.checkResponse(500, newSystemPrompt, TOOLS)
    expect(result.cacheBreakDetected).toBe(false)
  })

  it('无工具时也能正常工作', () => {
    const diag = new CacheDiagnostics()
    diag.recordBaseline(SYSTEM_PROMPT, undefined)

    const result = diag.checkResponse(300, SYSTEM_PROMPT, undefined)
    expect(result.cacheBreakDetected).toBe(false)
  })

  it('连续 recordBaseline + checkResponse 循环能检测下降（模拟实际 runtime 调用模式）', () => {
    const diag = new CacheDiagnostics()

    // Turn 1：recordBaseline → API 调用 → checkResponse
    diag.recordBaseline(SYSTEM_PROMPT, TOOLS)
    diag.checkResponse(10000, SYSTEM_PROMPT, TOOLS)

    // Turn 2：再次 recordBaseline（模拟 AgentLoop 每轮调用）→ checkResponse
    diag.recordBaseline(SYSTEM_PROMPT, TOOLS)
    const result = diag.checkResponse(3000, SYSTEM_PROMPT, TOOLS)

    // 应检测到显著下降（70% 下降，7000 tokens）
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.reason).toBe('significant_cache_read_drop')
    expect(result.tokenDelta).toBe(-7000)
  })

  it('连续多轮 recordBaseline + checkResponse 循环：稳定时不误报', () => {
    const diag = new CacheDiagnostics()

    // Turn 1
    diag.recordBaseline(SYSTEM_PROMPT, TOOLS)
    diag.checkResponse(5000, SYSTEM_PROMPT, TOOLS)

    // Turn 2：cache_read 略有增长
    diag.recordBaseline(SYSTEM_PROMPT, TOOLS)
    const r2 = diag.checkResponse(5200, SYSTEM_PROMPT, TOOLS)
    expect(r2.cacheBreakDetected).toBe(false)

    // Turn 3：cache_read 微降（2%）不触发
    diag.recordBaseline(SYSTEM_PROMPT, TOOLS)
    const r3 = diag.checkResponse(5100, SYSTEM_PROMPT, TOOLS)
    expect(r3.cacheBreakDetected).toBe(false)
  })
})

/**
 * T0-3：会话边界基线（改造前现状）
 *
 * agentHandler 每次 SEND_MESSAGE 都会 dispose 旧 AgentLoop 再 new 新的，
 * CacheDiagnostics 挂在 AgentLoop 实例上、不写入 SessionData —— 跨用户消息基线丢失。
 * 本套用例固化该现状，供 T1 会话级诊断对照。
 */
describe('T0-3 CacheDiagnostics 会话边界基线（改造前）', () => {
  let originalFetch: typeof globalThis.fetch

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch
  })

  it('同一 AgentLoop 实例内：第二轮可与第一轮对比并检出 cache_read 下降', () => {
    const diag = new CacheDiagnostics()
    diag.recordBaseline(SYSTEM_PROMPT, TOOLS)
    diag.checkResponse(10000, SYSTEM_PROMPT, TOOLS)

    diag.recordBaseline(SYSTEM_PROMPT, TOOLS)
    const result = diag.checkResponse(3000, SYSTEM_PROMPT, TOOLS)
    expect(result.cacheBreakDetected).toBe(true)
    expect(result.reason).toBe('significant_cache_read_drop')
  })

  it('模拟连续两次 SEND_MESSAGE（dispose+new）：第二轮无法与第一轮对比', () => {
    const sessionLifecycle = simulateSendMessageDisposeNew()

    // SEND_MESSAGE #1
    const diag1 = sessionLifecycle.getDiag()
    diag1.recordBaseline(SYSTEM_PROMPT, TOOLS)
    diag1.checkResponse(10000, SYSTEM_PROMPT, TOOLS)

    // agentHandler：dispose 旧 loop → new 新 loop（诊断实例随之丢弃）
    sessionLifecycle.dispose()

    // SEND_MESSAGE #2：全新 CacheDiagnostics，无上轮 lastCacheReadTokens
    const diag2 = sessionLifecycle.getDiag()
    expect(diag2).not.toBe(diag1)
    diag2.recordBaseline(SYSTEM_PROMPT, TOOLS)
    const result = diag2.checkResponse(3000, SYSTEM_PROMPT, TOOLS)

    // 现状：基线不跨 AgentLoop → 无法检出本应发现的显著下降
    expect(result.cacheBreakDetected).toBe(false)
    expect(result.reason).toBeUndefined()
  })

  it('不同 session 的诊断实例互不污染', () => {
    const sessionA = new CacheDiagnostics()
    const sessionB = new CacheDiagnostics()

    sessionA.recordBaseline(SYSTEM_PROMPT, TOOLS)
    sessionA.checkResponse(10000, SYSTEM_PROMPT, TOOLS)

    // B 从未建立过基线读数；即便 cache_read 很低也不应借用 A 的历史
    sessionB.recordBaseline(SYSTEM_PROMPT, TOOLS)
    const resultB = sessionB.checkResponse(100, SYSTEM_PROMPT, TOOLS)
    expect(resultB.cacheBreakDetected).toBe(false)

    // A 仍能在自身实例内继续对比
    sessionA.recordBaseline(SYSTEM_PROMPT, TOOLS)
    const resultA = sessionA.checkResponse(2000, SYSTEM_PROMPT, TOOLS)
    expect(resultA.cacheBreakDetected).toBe(true)
    expect(resultA.reason).toBe('significant_cache_read_drop')
  })

  it('诊断结果与结构指纹不含 prompt 正文 / API key / thinking', async () => {
    const sensitiveSystem =
      '你是编程助手。API_KEY=sk-secret-should-never-log。内部推理：先拆解问题…'
    const thinkingLeak = 'thinking: 用户想改缓存策略'

    const diag = new CacheDiagnostics()
    diag.recordBaseline(sensitiveSystem, TOOLS)
    const result = diag.checkResponse(100, thinkingLeak + sensitiveSystem, TOOLS)

    // 结果对象只允许结构化字段，不得回显敏感正文
    const resultJson = JSON.stringify(result)
    expect(resultJson).not.toContain('sk-secret')
    expect(resultJson).not.toContain('内部推理')
    expect(resultJson).not.toContain('用户想改缓存策略')
    expect(resultJson).not.toContain(sensitiveSystem)

    // 最终请求体结构指纹：捕获真实 body，只哈希结构
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
    for await (const _ of client.chat(messages, TOOLS)) {
      // drain
    }

    expect(capturedBody).not.toBeNull()
    const fp1 = fingerprintFinalRequestBody(capturedBody!)
    const fp2 = fingerprintFinalRequestBody(capturedBody!)
    expect(fp1).toBe(fp2)
    expect(fp1).toMatch(/^[a-f0-9]{16}$/)
    // 指纹本身是哈希，不含明文
    expect(fp1).not.toContain('sk-')
    expect(fp1).not.toContain('hello')
  })

  it('预期变化类别占位：同实例可区分 system / tools 变化（供 T1 扩展）', () => {
    const diag = new CacheDiagnostics()
    diag.recordBaseline(SYSTEM_PROMPT, TOOLS)
    diag.checkResponse(5000, SYSTEM_PROMPT, TOOLS)

    const systemChanged = diag.checkResponse(5000, SYSTEM_PROMPT + '\n规则更新', TOOLS)
    expect(systemChanged.reason).toBe('system_prompt_changed')

    diag.resetBaseline(SYSTEM_PROMPT, TOOLS)
    diag.checkResponse(5000, SYSTEM_PROMPT, TOOLS)
    const toolsChanged = diag.checkResponse(5000, SYSTEM_PROMPT, [
      { name: 'ls', description: '列出目录（改）', parameters: { type: 'object' } },
      { name: 'read', description: '读取文件', parameters: { type: 'object' } }
    ])
    expect(toolsChanged.reason).toBe('tool_schema_changed')
  })
})
