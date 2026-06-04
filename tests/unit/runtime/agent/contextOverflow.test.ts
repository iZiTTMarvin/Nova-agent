import { describe, it, expect } from 'vitest'
import { isContextOverflowError } from '../../../../src/runtime/agent/contextOverflow'

describe('contextOverflow', () => {
  it('应该只在 HTTP 400 时匹配', () => {
    expect(isContextOverflowError(200, 'context length')).toBe(false)
    expect(isContextOverflowError(500, 'context length exceeded')).toBe(false)
    expect(isContextOverflowError(400, 'context length exceeded')).toBe(true)
  })

  it('应该匹配 OpenAI 的错误信息', () => {
    expect(isContextOverflowError(400, 'This model\'s maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.')).toBe(true)
    expect(isContextOverflowError(400, 'Please reduce the length of the messages.')).toBe(true)
    expect(isContextOverflowError(400, 'context_length_exceeded')).toBe(true)
  })

  it('应该匹配 Anthropic 的错误信息', () => {
    expect(isContextOverflowError(400, 'prompt is too long')).toBe(true)
    expect(isContextOverflowError(400, 'Your prompt has 200000 tokens, which is > 100000 maximum.')).toBe(true)
  })

  it('应该匹配阿里千问/DashScope 的错误信息', () => {
    expect(isContextOverflowError(400, 'maximum input length')).toBe(true)
    expect(isContextOverflowError(400, 'parameter=input_tokens')).toBe(true)
    expect(isContextOverflowError(400, 'out of range of input length')).toBe(true)
  })

  it('应该匹配 DeepSeek 等其他通用提供商的错误信息', () => {
    expect(isContextOverflowError(400, 'context length exceeded')).toBe(true)
    expect(isContextOverflowError(400, 'tokens exceeds the model\'s maximum')).toBe(true)
    expect(isContextOverflowError(400, 'exceeds the model\'s context limit')).toBe(true)
  })

  it('对于不相关的 400 错误应该返回 false', () => {
    expect(isContextOverflowError(400, 'Invalid parameter type')).toBe(false)
    expect(isContextOverflowError(400, 'API key not provided')).toBe(false)
  })
})
