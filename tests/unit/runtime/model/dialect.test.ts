import { describe, expect, it } from 'vitest'
import { preferredToolDialect } from '../../../../src/runtime/model/dialect'

describe('preferredToolDialect', () => {
  it('MiniMax 走 XML', () => {
    expect(preferredToolDialect('MiniMax-M3')).toBe('xml')
    expect(preferredToolDialect('minimax-m2.5')).toBe('xml')
  })

  it('Kimi / GLM / Qwen / DeepSeek 走 XML', () => {
    expect(preferredToolDialect('kimi-k2.6')).toBe('xml')
    expect(preferredToolDialect('glm-4-plus')).toBe('xml')
    expect(preferredToolDialect('qwen-max')).toBe('xml')
    expect(preferredToolDialect('deepseek-v3')).toBe('xml')
  })

  it('Claude / GPT / o 系列走 native', () => {
    expect(preferredToolDialect('claude-3-5-sonnet')).toBe('native')
    expect(preferredToolDialect('gpt-4o')).toBe('native')
    expect(preferredToolDialect('o3-mini')).toBe('native')
  })

  it('未知模型默认走 XML', () => {
    expect(preferredToolDialect('some-unknown-model')).toBe('xml')
  })

  it('按 baseUrl 兜底识别 openai 原生端点', () => {
    expect(preferredToolDialect('custom-model', 'https://api.openai.com/v1')).toBe('native')
  })
})
