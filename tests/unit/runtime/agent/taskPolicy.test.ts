import { describe, expect, it } from 'vitest'
import {
  buildEconomyHardConstraints,
  resolveTaskPolicy
} from '../../../../src/runtime/agent/taskPolicy'

describe('resolveTaskPolicy', () => {
  it('无信号时默认为 default，且不启用工具经济', () => {
    const resolved = resolveTaskPolicy({
      instruction: 'fix this null pointer',
      surface: 'headless'
    })
    expect(resolved.tier).toBe('default')
    expect(resolved.matchedBy).toEqual([])
    expect(resolved.systemLayerText).toBe('')
    expect(resolved.toolEconomy).toBe(false)
  })

  it('指令关键词触发 economy', () => {
    const resolved = resolveTaskPolicy({
      instruction: 'Please write a csv summarizing the logs',
      surface: 'headless'
    })
    expect(resolved.tier).toBe('economy')
    expect(resolved.matchedBy).toContain('instruction')
    expect(resolved.toolEconomy).toBe(true)
    expect(resolved.systemLayerText).toBe(buildEconomyHardConstraints())
    expect(resolved.systemLayerText).toContain('shallow Glob')
  })

  it('元数据 category/tags 触发 economy', () => {
    const byCategory = resolveTaskPolicy({
      instruction: 'do the task',
      surface: 'headless',
      category: 'csv-processing'
    })
    expect(byCategory.tier).toBe('economy')
    expect(byCategory.matchedBy).toEqual(['metadata'])

    const byTag = resolveTaskPolicy({
      instruction: 'do the task',
      surface: 'headless',
      tags: ['summary']
    })
    expect(byTag.tier).toBe('economy')
    expect(byTag.matchedBy).toEqual(['metadata'])
  })

  it('显式配置开关触发 economy', () => {
    const resolved = resolveTaskPolicy({
      instruction: 'anything',
      surface: 'headless',
      economyTaskMode: true
    })
    expect(resolved.tier).toBe('economy')
    expect(resolved.matchedBy).toEqual(['config'])
  })

  it('heavy 与 economy 互斥且 heavy 优先', () => {
    const resolved = resolveTaskPolicy({
      instruction: 'write a csv after the refactor',
      surface: 'headless',
      economyTaskMode: true,
      heavyTaskMode: true
    })
    expect(resolved.tier).toBe('heavy')
    expect(resolved.toolEconomy).toBe(false)
    expect(resolved.systemLayerText).toContain('Heavy task guidance')
  })

  it('interactive 面 economy 仍正确分类，但不产生任何注入文案', () => {
    const resolved = resolveTaskPolicy({
      instruction: 'summarize the dataset',
      surface: 'interactive'
    })
    expect(resolved.tier).toBe('economy')
    expect(resolved.systemLayerText).toBe('')
  })
})
