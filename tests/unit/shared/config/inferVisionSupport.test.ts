/**
 * inferVisionSupport — 视觉能力推断回归
 */
import { describe, expect, it } from 'vitest'
import { inferVisionSupport } from '../../../../src/shared/config/types'

describe('inferVisionSupport', () => {
  it('deepseek-v4-pro / flash 不支持视觉', () => {
    expect(inferVisionSupport('deepseek-v4-pro')).toBe(false)
    expect(inferVisionSupport('deepseek-v4-flash')).toBe(false)
  })

  it('deepseek-chat / reasoner 不支持视觉', () => {
    expect(inferVisionSupport('deepseek-chat')).toBe(false)
    expect(inferVisionSupport('deepseek-reasoner')).toBe(false)
  })

  it('deepseek VL 变体支持视觉', () => {
    expect(inferVisionSupport('deepseek-vl')).toBe(true)
    expect(inferVisionSupport('deepseek-vl2')).toBe(true)
  })

  it('mimo 系列支持视觉', () => {
    expect(inferVisionSupport('mimo-v2.5')).toBe(true)
    expect(inferVisionSupport('mimo-v2.5-pro')).toBe(true)
  })

  it('常见视觉模型为 true', () => {
    expect(inferVisionSupport('gpt-4o')).toBe(true)
    expect(inferVisionSupport('claude-sonnet-4')).toBe(true)
    expect(inferVisionSupport('gemini-2.0-flash')).toBe(true)
  })

  it('纯文本 / 未知模型偏保守为 false', () => {
    expect(inferVisionSupport('gpt-3.5-turbo')).toBe(false)
    expect(inferVisionSupport('some-unknown-model')).toBe(false)
    expect(inferVisionSupport('')).toBe(false)
  })
})
