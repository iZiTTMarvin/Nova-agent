import { describe, expect, it } from 'vitest'
import { preferredToolDialect } from '../../../../src/runtime/model/dialect'

describe('preferredToolDialect', () => {
  it('MiniMax 默认走 native；ollama 强制走 XML', () => {
    expect(preferredToolDialect('MiniMax-M3')).toBe('native')
    expect(preferredToolDialect('minimax-m2.5')).toBe('native')
    expect(preferredToolDialect('llama3', 'http://localhost:11434/v1')).toBe('native')
    expect(preferredToolDialect('my-ollama-model', 'http://localhost:11434/v1')).toBe('xml')
  })

  it('国产主流官方端点走 native', () => {
    expect(
      preferredToolDialect('deepseek-v4-flash', 'https://api.deepseek.com/v1')
    ).toBe('native')
    expect(
      preferredToolDialect('kimi-k2', 'https://api.moonshot.cn/v1')
    ).toBe('native')
    expect(
      preferredToolDialect('glm-4.6', 'https://open.bigmodel.cn/api/paas/v4')
    ).toBe('native')
    expect(
      preferredToolDialect('qwen3-max', 'https://dashscope.aliyuncs.com/compatible-mode/v1')
    ).toBe('native')
    expect(
      preferredToolDialect('minimax-m3', 'https://api.minimax.chat/v1')
    ).toBe('native')
  })

  it('Kimi / GLM / Qwen 无官方 baseUrl 时默认 native', () => {
    expect(preferredToolDialect('kimi-k2.6')).toBe('native')
    expect(preferredToolDialect('glm-4-plus')).toBe('native')
    expect(preferredToolDialect('qwen-max')).toBe('native')
    expect(preferredToolDialect('deepseek-v3')).toBe('native')
  })

  it('Claude / GPT / o 系列走 native', () => {
    expect(preferredToolDialect('claude-3-5-sonnet')).toBe('native')
    expect(preferredToolDialect('gpt-4o')).toBe('native')
    expect(preferredToolDialect('o3-mini')).toBe('native')
  })

  it('未知模型 + 未知 baseUrl 默认 native', () => {
    expect(preferredToolDialect('some-unknown-model')).toBe('native')
    expect(
      preferredToolDialect('custom-model', 'https://proxy.example.com/v1')
    ).toBe('native')
  })

  it('按 baseUrl 识别 openai 原生端点', () => {
    expect(preferredToolDialect('custom-model', 'https://api.openai.com/v1')).toBe('native')
  })

  it('override 优先级最高', () => {
    expect(
      preferredToolDialect('gpt-4o', 'https://api.openai.com/v1', 'xml')
    ).toBe('xml')
    expect(
      preferredToolDialect('MiniMax-M3', undefined, 'native')
    ).toBe('native')
    expect(
      preferredToolDialect('minimax-m3', undefined, 'xml')
    ).toBe('xml')
    expect(
      preferredToolDialect('some-model', 'https://proxy.example.com', 'xml')
    ).toBe('xml')
  })
})
