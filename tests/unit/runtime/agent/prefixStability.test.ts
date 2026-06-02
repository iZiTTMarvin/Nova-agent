import { describe, it, expect } from 'vitest'
import { getStableSystemPrompt } from '../../../../src/runtime/agent/modePrompt'
import { getModeInstruction } from '../../../../src/runtime/agent/modeInstruction'
import type { Mode } from '../../../../src/shared/session/types'

describe('前缀稳定性 (缓存 Harness C2)', () => {
  it('getStableSystemPrompt 对不同模式返回相同内容', () => {
    const prompt = getStableSystemPrompt()
    expect(prompt).toBeTruthy()
    expect(prompt.length).toBeGreaterThan(100)

    // 多次调用返回完全相同的内容（逐字节稳定）
    const prompt2 = getStableSystemPrompt()
    expect(prompt2).toBe(prompt)
  })

  it('getStableSystemPrompt 不包含任何模式特定文本', () => {
    const prompt = getStableSystemPrompt()
    // 不应包含"当前处于 xxx 模式"这种模式特定文本
    expect(prompt).not.toContain('当前处于 plan 模式')
    expect(prompt).not.toContain('当前处于 default 模式')
    expect(prompt).not.toContain('当前处于 auto 模式')
  })

  it('getModeInstruction 为每种模式返回非空文本', () => {
    const modes: Mode[] = ['plan', 'default', 'auto']
    for (const mode of modes) {
      const instruction = getModeInstruction(mode)
      expect(instruction).toBeTruthy()
      expect(instruction.length).toBeGreaterThan(10)
    }
  })

  it('getModeInstruction 包含模式名称标记', () => {
    expect(getModeInstruction('plan')).toContain('plan')
    expect(getModeInstruction('default')).toContain('default')
    expect(getModeInstruction('auto')).toContain('auto')
  })

  it('不同模式的 mode instruction 互不相同', () => {
    const planInstruction = getModeInstruction('plan')
    const defaultInstruction = getModeInstruction('default')
    const autoInstruction = getModeInstruction('auto')

    expect(planInstruction).not.toBe(defaultInstruction)
    expect(defaultInstruction).not.toBe(autoInstruction)
    expect(planInstruction).not.toBe(autoInstruction)
  })
})
