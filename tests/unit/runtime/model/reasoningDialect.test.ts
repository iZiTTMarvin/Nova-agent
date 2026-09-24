import { describe, it, expect } from 'vitest'
import { buildReasoningParams } from '../../../../src/runtime/model/reasoningDialect'

describe('buildReasoningParams', () => {
  it('GLM 端点 + auto：注入 thinking.clear_thinking=false，不带 reasoning_effort', () => {
    expect(
      buildReasoningParams('glm-coding-plan', 'https://open.bigmodel.cn/api/coding/paas/v4', 'auto')
    ).toEqual({
      thinking: { type: 'enabled', clear_thinking: false }
    })
  })

  it('GLM 端点：bigmodel.cn + high 注入 thinking + reasoning_effort', () => {
    const params = buildReasoningParams(
      'glm-4.6',
      'https://open.bigmodel.cn/api/coding/paas/v4',
      'high'
    )
    expect(params).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: 'high'
    })
  })

  it('GLM 端点：z.ai 同样走 GLM 方言', () => {
    const params = buildReasoningParams('glm-5.2', 'https://api.z.ai/api/paas/v4', 'low')
    expect(params).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: 'low'
    })
  })

  it('GLM 端点 + none/minimal：不注入 thinking', () => {
    expect(
      buildReasoningParams('glm-4.6', 'https://open.bigmodel.cn/api/paas/v4', 'none')
    ).toBeNull()
    expect(
      buildReasoningParams('glm-4.6', 'https://open.bigmodel.cn/api/paas/v4', 'minimal')
    ).toBeNull()
  })

  it('DeepSeek 端点：仅注入 reasoning_effort', () => {
    const params = buildReasoningParams(
      'deepseek-reasoner',
      'https://api.deepseek.com/v1',
      'low'
    )
    expect(params).toEqual({ reasoning_effort: 'low' })
    expect(params).not.toHaveProperty('thinking')
  })

  it('DeepSeek 端点：max 原样透传', () => {
    expect(
      buildReasoningParams(
        'deepseek-v4-flash',
        'https://api.deepseek.com',
        'max'
      )
    ).toEqual({ reasoning_effort: 'max' })
  })

  it('非 GLM + auto：不注入', () => {
    expect(
      buildReasoningParams('deepseek-reasoner', 'https://api.deepseek.com/v1', 'auto')
    ).toBeNull()
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
      thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: 'high'
    })
  })

  it('空 baseUrl 仍走默认方言（非 GLM）', () => {
    const params = buildReasoningParams('glm-4.6', '', 'high')
    expect(params).toEqual({ reasoning_effort: 'high' })
  })

  it('MiniMax 的产品档位保持 adaptive 思考，不发送未文档化 effort', () => {
    expect(buildReasoningParams('MiniMax-M3', 'https://api.minimaxi.com/v1', 'high'))
      .toEqual({ thinking: { type: 'adaptive' } })
    expect(buildReasoningParams('MiniMax-M3', 'https://api.minimax.io/v1', 'max'))
      .toEqual({ thinking: { type: 'adaptive' } })
    expect(buildReasoningParams('MiniMax-M2.5', 'https://api.minimax.chat/v1', 'high'))
      .toEqual({ thinking: { type: 'adaptive' } })
  })

  it('已登记模型收到不支持档位时不向服务商发送无效参数', () => {
    expect(
      buildReasoningParams('glm-5.3', 'https://open.bigmodel.cn/api/paas/v4', 'medium')
    ).toBeNull()
  })

  it('MiniMax + none/minimal：显式 disabled，而不是省略', () => {
    expect(buildReasoningParams('MiniMax-M3', 'https://api.minimaxi.com/v1', 'none')).toEqual({
      thinking: { type: 'disabled' }
    })
    expect(buildReasoningParams('MiniMax-M3', 'https://api.minimaxi.com/v1', 'minimal')).toEqual({
      thinking: { type: 'disabled' }
    })
  })

  it('MiniMax + auto：不注入，沿用服务商默认开思考', () => {
    expect(buildReasoningParams('MiniMax-M3', 'https://api.minimaxi.com/v1', 'auto')).toBeNull()
  })
})
