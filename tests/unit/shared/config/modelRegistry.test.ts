/**
 * modelRegistry / resolveSupportsVision — 精确注册表与优先级链
 */
import { describe, expect, it } from 'vitest'
import {
  lookupModelCapability,
  MODEL_CAPABILITY_REGISTRY
} from '../../../../src/shared/config/modelRegistry'
import { resolveSupportsVision } from '../../../../src/shared/config/types'

describe('lookupModelCapability', () => {
  it('精确命中已收录模型', () => {
    expect(lookupModelCapability('gpt-4o')?.supportsVision).toBe(true)
    expect(lookupModelCapability('glm-5.1')?.supportsVision).toBe(false)
    expect(lookupModelCapability('kimi-k2.6')?.supportsVision).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(lookupModelCapability('GPT-4O')?.supportsVision).toBe(true)
    expect(lookupModelCapability('Glm-5.1')?.supportsVision).toBe(false)
    expect(lookupModelCapability('Kimi-K2.7-Code')?.supportsVision).toBe(true)
  })

  it('未收录返回 undefined', () => {
    expect(lookupModelCapability('some-unknown-model-xyz')).toBeUndefined()
    expect(lookupModelCapability('')).toBeUndefined()
  })

  it('注册表键均为小写（查找约定）', () => {
    for (const key of Object.keys(MODEL_CAPABILITY_REGISTRY)) {
      expect(key).toBe(key.toLowerCase())
    }
  })
})

describe('resolveSupportsVision', () => {
  it('用户显式勾选优先于注册表', () => {
    // glm-5.1 注册表为 false，显式 true 应采纳
    expect(resolveSupportsVision('glm-5.1', true)).toBe(true)
    // gpt-4o 注册表为 true，显式 false 应采纳
    expect(resolveSupportsVision('gpt-4o', false)).toBe(false)
  })

  it('无显式勾选时命中注册表', () => {
    expect(resolveSupportsVision('glm-5.1')).toBe(false)
    expect(resolveSupportsVision('glm-5.2')).toBe(false)
    expect(resolveSupportsVision('gpt-4o')).toBe(true)
    expect(resolveSupportsVision('gpt-5.5')).toBe(true)
    expect(resolveSupportsVision('claude-sonnet-5')).toBe(true)
    expect(resolveSupportsVision('claude-opus-4-8')).toBe(true)
    expect(resolveSupportsVision('gemini-3.5-flash')).toBe(true)
    expect(resolveSupportsVision('kimi-k2.7-code')).toBe(true)
    expect(resolveSupportsVision('kimi-k2')).toBe(false)
  })

  it('注册表纠偏模糊兜底误判（mimo-v2.5-pro / minimax-m2.5）', () => {
    // inferVisionSupport 对 mimo / minimax 一律 true；注册表精确为 false
    expect(resolveSupportsVision('mimo-v2.5-pro')).toBe(false)
    expect(resolveSupportsVision('minimax-m2.5')).toBe(false)
  })

  it('未收录时回退字符串兜底 inferVisionSupport', () => {
    // deepseek-vl 未收录，但模糊兜底含 vl → true
    expect(resolveSupportsVision('deepseek-vl')).toBe(true)
    // 完全未知 → false
    expect(resolveSupportsVision('totally-unknown-model-xyz')).toBe(false)
  })
})
