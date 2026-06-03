import { describe, it, expect } from 'vitest'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import type { ToolDefinition } from '../../../../src/runtime/model/types'

const SYSTEM_PROMPT = '你是编程助手'
const TOOLS: ToolDefinition[] = [
  { name: 'ls', description: '列出目录', parameters: { type: 'object' } },
  { name: 'read', description: '读取文件', parameters: { type: 'object' } }
]

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
