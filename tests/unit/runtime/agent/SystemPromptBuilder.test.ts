import { describe, it, expect } from 'vitest'
import { SystemPromptBuilder } from '../../../../src/runtime/agent/promptBuilder/SystemPromptBuilder'

describe('SystemPromptBuilder', () => {
  const fullLayers = {
    agentRole: '你是助手',
    baseRules: '遵守规则',
    projectRules: '项目规则内容',
    skillContext: '<skills>- a</skills>',
    modeInstruction: 'default 模式',
    toolSummary: '- ls: 列目录'
  }

  it('6 层按固定顺序拼接', () => {
    const out = SystemPromptBuilder.build(fullLayers)
    const agentIdx = out.indexOf('=== Agent Role ===')
    const baseIdx = out.indexOf('=== Base Rules ===')
    const projIdx = out.indexOf('=== Project Rules')
    const skillIdx = out.indexOf('=== Skills ===')
    const modeIdx = out.indexOf('=== Mode ===')
    const toolIdx = out.indexOf('=== Available Tools ===')
    expect(agentIdx).toBeLessThan(baseIdx)
    expect(baseIdx).toBeLessThan(projIdx)
    expect(projIdx).toBeLessThan(skillIdx)
    expect(skillIdx).toBeLessThan(modeIdx)
    expect(modeIdx).toBeLessThan(toolIdx)
  })

  it('空层自动跳过', () => {
    const out = SystemPromptBuilder.build({ agentRole: 'role only', baseRules: '' })
    expect(out).toContain('=== Agent Role ===')
    expect(out).not.toContain('=== Base Rules ===')
  })

  it('buildLayer 包裹标题', () => {
    expect(SystemPromptBuilder.buildLayer('Test', 'content')).toBe('=== Test ===\ncontent')
  })

  it('包含各层正文', () => {
    const out = SystemPromptBuilder.build(fullLayers)
    expect(out).toContain('你是助手')
    expect(out).toContain('项目规则内容')
    expect(out).toContain('<skills>')
  })

  it('projectRules 为 null 时跳过', () => {
    const out = SystemPromptBuilder.build({ agentRole: 'r', projectRules: null })
    expect(out).not.toContain('Project Rules')
  })

  it('仅 agentRole 时输出单层', () => {
    const out = SystemPromptBuilder.build({ agentRole: 'solo' })
    expect(out.split('===').length - 1).toBe(2)
  })

  it('trim 层内容首尾空白', () => {
    const out = SystemPromptBuilder.build({ agentRole: '  spaced  ' })
    expect(out).toContain('spaced')
    expect(out).not.toContain('  spaced  ')
  })

  it('层与层之间双换行分隔', () => {
    const out = SystemPromptBuilder.build({
      agentRole: 'a',
      baseRules: 'b'
    })
    expect(out).toContain('=== Agent Role ===\na\n\n=== Base Rules ===')
  })
})
