import { describe, it, expect } from 'vitest'
import { isContextOverflowError } from '../../../../src/runtime/agent/recovery/contextOverflow'

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

  describe('否决层', () => {
    it('限速消息含 token 字样 → 不判溢出', () => {
      expect(isContextOverflowError(
        400,
        'ThrottlingException: too many tokens, please wait before trying again',
      )).toBe(false)
      expect(isContextOverflowError(
        400,
        "ThrottlingException: quota exceeded. This endpoint's maximum context length is 262144 tokens.",
      )).toBe(false)
      expect(isContextOverflowError(
        400,
        'Rate limit exceeded: please reduce token usage and retry',
      )).toBe(false)
    })

    it('输出侧超限 → 不判溢出', () => {
      expect(isContextOverflowError(400, 'Output token limit exceeded')).toBe(false)
      expect(isContextOverflowError(400, 'Maximum output token limit exceeded')).toBe(false)
      expect(isContextOverflowError(
        400,
        'output token count of 8192 exceeds the limit of 4096',
      )).toBe(false)
      expect(isContextOverflowError(
        400,
        'completion has too many tokens for this model',
      )).toBe(false)
      expect(isContextOverflowError(
        400,
        'Invalid request: max_tokens token limit exceeded',
      )).toBe(false)
      expect(isContextOverflowError(
        400,
        'too many tokens were requested for the completion',
      )).toBe(false)
      expect(isContextOverflowError(
        400,
        "Too many completion tokens were requested. This endpoint's maximum context length is 262144 tokens.",
      )).toBe(false)
    })

    it('真实输入溢出仍判溢出（OpenAI / Anthropic / DeepSeek / Qwen）', () => {
      expect(isContextOverflowError(
        400,
        "This model's maximum context length is 8192 tokens. However, you requested 10240 tokens (10140 in the messages, 100 in the completion). Please reduce the length of the messages or completion.",
      )).toBe(true)
      expect(isContextOverflowError(
        400,
        'Your prompt has 200000 tokens, which is > 100000 maximum.',
      )).toBe(true)
      expect(isContextOverflowError(400, 'context length exceeded')).toBe(true)
      expect(isContextOverflowError(400, 'parameter=input_tokens')).toBe(true)
      expect(isContextOverflowError(400, 'Input token limit exceeded: 250000 tokens > 200000 maximum')).toBe(true)
    })
  })
})
