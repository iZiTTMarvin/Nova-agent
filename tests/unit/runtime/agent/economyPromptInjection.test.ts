import { describe, expect, it } from 'vitest'
import { SystemPromptBuilder } from '../../../../src/runtime/agent/promptBuilder/SystemPromptBuilder'
import {
  buildEconomyHardConstraints,
  resolveTaskPolicy
} from '../../../../src/runtime/agent/taskPolicy'

describe('headless economy prompt injection', () => {
  it('economy 任务的 systemLayerText 可经 SystemPromptBuilder 注入', () => {
    const policy = resolveTaskPolicy({
      instruction: 'write a csv of results',
      surface: 'headless',
      economyTaskMode: true
    })
    expect(policy.systemLayerText).toBe(buildEconomyHardConstraints())

    const prompt = SystemPromptBuilder.build({
      agentRole: 'role',
      taskPolicy: policy.systemLayerText,
      toolSummary: '- read'
    })
    expect(prompt).toContain('=== Task Policy ===')
    expect(prompt).toContain('shallow Glob')
    expect(prompt).toContain('at most 2 sample files')
  })

  it('interactive economy 不产生可注入的硬约束层', () => {
    const policy = resolveTaskPolicy({
      instruction: 'summarize logs',
      surface: 'interactive'
    })
    expect(policy.systemLayerText).toBe('')
    const prompt = SystemPromptBuilder.build({
      agentRole: 'role',
      taskPolicy: policy.systemLayerText
    })
    expect(prompt).not.toContain('Task Policy')
  })
})
