import { describe, expect, it } from 'vitest'
import { getSystemPromptForMode } from '../../../../src/runtime/agent/modePrompt'

describe('getSystemPromptForMode', () => {
  it('plan 模式提示词应明确只读规划约束', () => {
    const prompt = getSystemPromptForMode('plan')

    expect(prompt).toContain('plan 模式')
    expect(prompt).toContain('只读规划模式')
    expect(prompt).toContain('不能编辑文件')
    expect(prompt).toContain('不要把完整可直接落盘的实现文件内容')
    expect(prompt).toContain('切换到 default 或 auto 模式')
  })

  it('default 与 auto 模式应保留实现型心智', () => {
    expect(getSystemPromptForMode('default')).toContain('default 模式')
    expect(getSystemPromptForMode('auto')).toContain('auto 模式')
  })
})
