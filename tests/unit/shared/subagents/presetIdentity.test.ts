import { describe, expect, it } from 'vitest'
import {
  SUBAGENT_PRESET_ID_MAX_LENGTH,
  generateSubagentPresetId,
  isValidSubagentPresetId,
  normalizeSubagentPresetId
} from '../../../../src/shared/subagents/presetIdentity'

describe('normalizeSubagentPresetId', () => {
  it.each([
    ['My Agent', 'my-agent'],
    ['  Padded Name  ', 'padded-name'],
    ['multi   space', 'multi-space'],
    ['a.b_c-d', 'a.b_c-d'],
    ['UPPER-CASE', 'upper-case'],
    ['weird!!name', 'weirdname'],
    ['__leading', 'leading'],
    ['trailing__', 'trailing'],
    ['你好', ''],
    ['🤖 bot', 'bot'],
    ['x -- y', 'x-y'],
    ['a__b', 'a__b']
  ])('「%s」→「%s」', (input, expected) => {
    expect(normalizeSubagentPresetId(input)).toBe(expected)
  })
})

describe('generateSubagentPresetId', () => {
  it('中文/特殊字符结果过短或为空时落到兜底基底', () => {
    expect(generateSubagentPresetId('你好', [])).toBe('subagent')
    expect(generateSubagentPresetId('你好', ['subagent'])).toBe('subagent-2')
  })

  it('与已有 ID 冲突时追加确定性数字后缀', () => {
    expect(generateSubagentPresetId('helper', ['helper'])).toBe('helper-2')
    expect(generateSubagentPresetId('helper', ['helper', 'helper-2'])).toBe('helper-3')
  })

  it('内置保留 ID 永不占用，即使调用方忘记传入', () => {
    expect(generateSubagentPresetId('explore', [])).toBe('explore-2')
    expect(generateSubagentPresetId('review', [])).toBe('review-2')
  })

  it('生成结果始终合法且不超过长度上限，含后缀', () => {
    const long = 'a'.repeat(200)
    expect(generateSubagentPresetId(long, [])).toBe('a'.repeat(64))
    const generated = generateSubagentPresetId(long, ['a'.repeat(64)])
    expect(generated.length).toBeLessThanOrEqual(SUBAGENT_PRESET_ID_MAX_LENGTH)
    expect(isValidSubagentPresetId(generated)).toBe(true)
    expect(generated.endsWith('-2')).toBe(true)
  })

  it('对同一显示名与同一 taken 集合结果确定', () => {
    const first = generateSubagentPresetId('测试 助手', ['subagent'])
    const second = generateSubagentPresetId('测试 助手', ['subagent'])
    expect(first).toBe(second)
  })
})

describe('isValidSubagentPresetId', () => {
  it.each([
    ['a', true],
    ['my-helper', true],
    ['helper.v2', true],
    ['helper_v2', true],
    ['a-'.repeat(32).slice(0, 62) + '9', true],
    ['-leading', false],
    ['trailing-', false],
    ['Upper', false],
    ['中文名', false],
    ['', false],
    ['a'.repeat(SUBAGENT_PRESET_ID_MAX_LENGTH + 1), false]
  ])('「%s」合法=%s', (id, valid) => {
    expect(isValidSubagentPresetId(id)).toBe(valid)
  })
})
