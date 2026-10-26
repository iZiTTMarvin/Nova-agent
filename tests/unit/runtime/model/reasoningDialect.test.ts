import { describe, it, expect } from 'vitest'
import { buildReasoningParams } from '../../../../src/runtime/model/reasoningDialect'
import { MODEL_CAPABILITY_REGISTRY } from '../../../../src/shared/config/modelRegistry'

describe('buildReasoningParams', () => {
  it('DeepSeek minimal 保持思考并归一为 Low', () => {
    expect(buildReasoningParams('deepseek-v4-pro', 'https://api.deepseek.com/v1', 'minimal'))
      .toEqual({ reasoning_effort: 'low' })
  })
  it('每个登记强度都生成可区分的请求参数', () => {
    for (const [modelId, entry] of Object.entries(MODEL_CAPABILITY_REGISTRY)) {
      if (entry.reasoning?.kind !== 'effort') continue
      const bodies = entry.reasoning.levels.map(level => JSON.stringify(buildReasoningParams(modelId, 'https://custom.example/v1', level)))
      expect(bodies, modelId).not.toContain('null')
      expect(new Set(bodies).size, modelId).toBe(entry.reasoning.levels.length)
    }
  })
  it('GLM-5.2 的旧 Low/Medium 选择使用实际 High 强度', () => {
    for (const effort of ['low', 'medium'] as const) {
      expect(buildReasoningParams('glm-5.2', 'https://open.bigmodel.cn/api/paas/v4', effort))
        .toEqual({ thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: 'high' })
    }
  })

  it('MiniMax-M3.1-Flash 保留可区分的思考强度', () => {
    expect(buildReasoningParams('MiniMax-M3.1-Flash', 'https://api.minimax.io/v1', 'xhigh'))
      .toEqual({ thinking: { type: 'adaptive' }, reasoning_effort: 'xhigh' })
  })

  it('Kimi 按版本区分开关与强度，关闭不误用 reasoning_effort', () => {
    expect(buildReasoningParams('kimi-k2.6', 'https://api.moonshot.ai/v1', 'none'))
      .toEqual({ thinking: { type: 'disabled' } })
    expect(buildReasoningParams('kimi-k2.6', 'https://api.moonshot.ai/v1', 'enabled'))
      .toEqual({ thinking: { type: 'enabled' } })
    expect(buildReasoningParams('kimi-k3.1-pro', 'https://api.moonshot.ai/v1', 'max'))
      .toEqual({ reasoning_effort: 'max' })
    expect(buildReasoningParams('kimi-k2.7-code', 'https://api.moonshot.ai/v1', 'none')).toBeNull()
  })

  it('DeepSeek 关闭思考发送显式开关', () => {
    expect(buildReasoningParams('deepseek-v4-pro', 'https://api.deepseek.com/v1', 'none'))
      .toEqual({ thinking: { type: 'disabled' } })
  })
  it('GLM 端点 + auto：注入 thinking.clear_thinking=false，不带 reasoning_effort', () => {
    expect(
      buildReasoningParams('glm-5.2', 'https://open.bigmodel.cn/api/coding/paas/v4', 'auto')
    ).toEqual({
      thinking: { type: 'enabled', clear_thinking: false }
    })
  })

  it('GLM 端点：bigmodel.cn + high 注入 thinking + reasoning_effort', () => {
    const params = buildReasoningParams(
      'glm-5.2',
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
      reasoning_effort: 'high'
    })
  })

  it('支持关闭的 GLM 显式关闭思考', () => {
    expect(
      buildReasoningParams('glm-4.6', 'https://open.bigmodel.cn/api/paas/v4', 'none')
    ).toEqual({ thinking: { type: 'disabled' } })
    expect(
      buildReasoningParams('glm-4.6', 'https://open.bigmodel.cn/api/paas/v4', 'minimal')
    ).toEqual({ thinking: { type: 'disabled' } })
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

  it('未知型号不注入猜测的 reasoning_effort', () => {
    const params = buildReasoningParams('some-model', 'https://custom.example.com/v1', 'low')
    expect(params).toBeNull()
  })

  it('baseUrl 大小写不敏感', () => {
    const params = buildReasoningParams('glm-5.2', 'HTTPS://OPEN.BIGMODEL.CN/api/paas/v4', 'high')
    expect(params).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: 'high'
    })
  })

  it('已登记模型的临时配置沿用公开协议', () => {
    const params = buildReasoningParams('glm-5.2', '', 'high')
    expect(params).toEqual({ thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: 'high' })
  })

  it('MiniMax 的产品档位保持 adaptive 思考，不发送未文档化 effort', () => {
    expect(buildReasoningParams('MiniMax-M3', 'https://api.minimaxi.com/v1', 'high'))
      .toEqual({ thinking: { type: 'adaptive' } })
    expect(buildReasoningParams('MiniMax-M3', 'https://api.minimax.io/v1', 'max'))
      .toEqual({ thinking: { type: 'adaptive' } })
    expect(buildReasoningParams('MiniMax-M2.5', 'https://api.minimax.chat/v1', 'high'))
      .toBeNull()
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
