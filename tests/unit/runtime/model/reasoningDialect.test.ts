import { describe, it, expect } from 'vitest'
import { buildReasoningParams } from '../../../../src/runtime/model/reasoningDialect'

describe('buildReasoningParams', () => {
  it('auto 返回 null（不注入，零行为变化）', () => {
    expect(buildReasoningParams('glm-coding-plan', 'https://open.bigmodel.cn/api/coding/paas/v4', 'auto')).toBeNull()
  })

  it('GLM 端点：bigmodel.cn 注入 thinking + reasoning_effort', () => {
    const params = buildReasoningParams('glm-4.6', 'https://open.bigmodel.cn/api/coding/paas/v4', 'high')
    expect(params).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high'
    })
  })

  it('GLM 端点：z.ai 同样走 GLM 方言', () => {
    const params = buildReasoningParams('glm-5.2', 'https://api.z.ai/api/paas/v4', 'low')
    expect(params).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low'
    })
  })

  it('DeepSeek 端点：仅注入 reasoning_effort', () => {
    const params = buildReasoningParams('deepseek-reasoner', 'https://api.deepseek.com/v1', 'medium')
    expect(params).toEqual({ reasoning_effort: 'medium' })
    // 确认不带 thinking 对象
    expect(params).not.toHaveProperty('thinking')
  })

  it('OpenAI 端点：仅注入 reasoning_effort', () => {
    const params = buildReasoningParams('o3', 'https://api.openai.com/v1', 'high')
    expect(params).toEqual({ reasoning_effort: 'high' })
  })

  it('未知端点：默认走纯 reasoning_effort', () => {
    const params = buildReasoningParams('some-model', 'https://custom.example.com/v1', 'low')
    expect(params).toEqual({ reasoning_effort: 'low' })
  })

  it('baseUrl 大小写不敏感', () => {
    const params = buildReasoningParams('glm-4.6', 'HTTPS://OPEN.BIGMODEL.CN/api/paas/v4', 'high')
    expect(params).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high'
    })
  })

  it('空 baseUrl 仍走默认方言', () => {
    const params = buildReasoningParams('glm-4.6', '', 'high')
    expect(params).toEqual({ reasoning_effort: 'high' })
  })
})
