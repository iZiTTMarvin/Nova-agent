import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { estimateTokens } from '../../../../src/runtime/agent/tokenEstimator'
import { renderBaseRules } from '../../../../src/runtime/agent/promptRenderer'

describe('promptRenderer', () => {
  it('renderBaseRules() 返回非空字符串', () => {
    const text = renderBaseRules()
    expect(text).toBeTruthy()
    expect(text.length).toBeGreaterThan(100)
  })

  it('返回内容 token 数 < 1000', () => {
    const text = renderBaseRules()
    expect(estimateTokens(text)).toBeLessThan(1000)
  })

  it('包含五条行为契约要点', () => {
    const text = renderBaseRules()
    expect(text).toContain('工具优先级')
    expect(text).toContain('探索策略')
    expect(text).toContain('完成度契约')
    expect(text).toContain('yield 前')
    expect(text).toContain('模式与写入')
  })

  it('不包含模式指令正文（模式约束挂 user 尾部）', () => {
    const text = renderBaseRules()
    expect(text).not.toContain('[当前模式: plan')
    expect(text).not.toContain('[当前模式: default')
    expect(text).not.toContain('[当前模式: auto')
  })

  it('只引用已注册工具名，不出现 Glob / SemanticSearch 等幻觉工具', () => {
    const text = renderBaseRules()
    // 独立工具名 Glob、SemanticSearch 未注册；glob 作为 grep 参数名允许出现
    expect(text).not.toMatch(/\bGlob\b/)
    expect(text).not.toMatch(/\bSemanticSearch\b/)
    expect(text).toContain('`find`')
    expect(text).toContain('`grep`')
  })

  it('文件不存在时返回空字符串且不抛错', () => {
    expect(renderBaseRules(join(__dirname, '__missing_base_rules__.md'))).toBe('')
  })

  it('base-rules.md 源文件存在且非空', () => {
    const filePath = join(__dirname, '../../../../src/runtime/agent/prompts/base-rules.md')
    expect(existsSync(filePath)).toBe(true)
    const raw = readFileSync(filePath, 'utf-8').trim()
    expect(raw.length).toBeGreaterThan(0)
    expect(estimateTokens(raw)).toBeLessThan(1000)
  })
})
