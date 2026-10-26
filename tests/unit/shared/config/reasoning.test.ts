import { describe, expect, it } from 'vitest'
import {
  getReasoningChoices, normalizeReasoningEffort, resolveReasoningSelection,
  reasoningSelectionLabel
} from '../../../../src/shared/config/reasoning'

describe('思考选择与真实能力', () => {
  it('GLM 别名不制造虚假档位，默认保留省略参数的语义', () => {
    expect(getReasoningChoices('glm-5.2')).toEqual(['auto', 'none', 'high', 'max'])
    expect(normalizeReasoningEffort('glm-5.2', 'medium')).toBe('high')
    expect(resolveReasoningSelection({ modelId: 'glm-5.2' })).toBe('auto')
    expect(reasoningSelectionLabel('glm-5.2', 'auto')).toBe('默认 · Max')
    expect(resolveReasoningSelection({ modelId: 'glm-5.2', reasoningEffort: 'high' }, 'auto')).toBe('auto')
  })

  it('MiniMax 固定、开关、强度按具体型号区分', () => {
    expect(getReasoningChoices('MiniMax-M2.7')).toEqual(['auto'])
    expect(getReasoningChoices('MiniMax-M3')).toEqual(['auto', 'none', 'enabled'])
    expect(getReasoningChoices('MiniMax-M3.1-Flash')).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(normalizeReasoningEffort('MiniMax-M3', 'max')).toBe('enabled')
    expect(normalizeReasoningEffort('MiniMax-M3.1-Flash', 'none')).toBeUndefined()
    expect(getReasoningChoices('MiniMax-M3.2')).toBeNull()
  })

  it('未知能力不猜测，不接受关闭或任意强度', () => {
    expect(getReasoningChoices('custom-model')).toBeNull()
    expect(reasoningSelectionLabel('custom-model', 'auto')).toBe('服务商默认')
    expect(normalizeReasoningEffort('custom-model', 'max')).toBeUndefined()
  })

  it('GPT 服务商默认按具体型号表达，关闭能力不外推到强制思考型号', () => {
    expect(reasoningSelectionLabel('gpt-5.4', 'auto')).toBe('默认 · 关闭')
    expect(getReasoningChoices('gpt-5.4')).toContain('none')
    expect(getReasoningChoices('gpt-6-astra')).not.toContain('none')
    expect(reasoningSelectionLabel('gpt-6.1-sol', 'auto')).toBe('默认 · Medium')
  })
})
