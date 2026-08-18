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

  it('taskPolicy 插在 modeInstruction 之后、toolSummary 之前', () => {
    const out = SystemPromptBuilder.build({
      ...fullLayers,
      taskPolicy: 'Economy task constraints'
    })
    const modeIdx = out.indexOf('=== Mode ===')
    const policyIdx = out.indexOf('=== Task Policy ===')
    const toolIdx = out.indexOf('=== Available Tools ===')
    expect(policyIdx).toBeGreaterThan(modeIdx)
    expect(policyIdx).toBeLessThan(toolIdx)
    expect(out).toContain('Economy task constraints')
  })

  it('taskPolicy 为空时跳过该层', () => {
    const out = SystemPromptBuilder.build({ agentRole: 'r', taskPolicy: '   ' })
    expect(out).not.toContain('Task Policy')
  })

  it('memoryContext 插在 projectRules 之后、skillContext 之前', () => {
    const out = SystemPromptBuilder.build({
      ...fullLayers,
      memoryContext: 'Memory is historical evidence.'
    })
    const projIdx = out.indexOf('=== Project Rules')
    const memIdx = out.indexOf('=== Memory Policy ===')
    const skillIdx = out.indexOf('=== Skills ===')
    expect(memIdx).toBeGreaterThan(projIdx)
    expect(memIdx).toBeLessThan(skillIdx)
    expect(out).toContain('Memory is historical evidence.')
  })

  it('memoryContext 为空或 null 时跳过该层', () => {
    const withNull = SystemPromptBuilder.build({ agentRole: 'r', memoryContext: null })
    const withEmpty = SystemPromptBuilder.build({ agentRole: 'r', memoryContext: '   ' })
    expect(withNull).not.toContain('Memory Policy')
    expect(withEmpty).not.toContain('Memory Policy')
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
