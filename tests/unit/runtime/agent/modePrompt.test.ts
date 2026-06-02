import { describe, expect, it } from 'vitest'
import { getStableSystemPrompt } from '../../../../src/runtime/agent/modePrompt'

describe('getStableSystemPrompt', () => {
  it('应包含工具列表和模式说明', () => {
    const prompt = getStableSystemPrompt()

    expect(prompt).toContain('ls')
    expect(prompt).toContain('read')
    expect(prompt).toContain('grep')
    expect(prompt).toContain('edit')
    expect(prompt).toContain('write')
    expect(prompt).toContain('bash')
    expect(prompt).toContain('plan')
    expect(prompt).toContain('default')
    expect(prompt).toContain('auto')
  })

  it('多次调用返回逐字节相同内容', () => {
    expect(getStableSystemPrompt()).toBe(getStableSystemPrompt())
  })
})
