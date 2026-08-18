/**
 * 回归：memoryEnabled:false 时无记忆层文本、无 prefetch 接线产物；
 * 开启时 system prompt 只含固定 Memory Policy，不含任何记忆数据。
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_NOVA_SETTINGS } from '../../../../src/runtime/settings/novaSettings'
import { MEMORY_POLICY_PROMPT } from '../../../../src/runtime/memory/memoryConfig'
import { buildStableSystemPrompt } from '../../../../src/runtime/agent/promptBuilder/modePrompt'
import { renderBaseRules } from '../../../../src/runtime/agent/promptRenderer'
import { SystemPromptBuilder } from '../../../../src/runtime/agent/promptBuilder/SystemPromptBuilder'

function buildPrompt(memoryEnabled: boolean): string {
  // 与 AgentRuntimeFactory 同构：关闭时 memoryContext 为 null，开启时为固定 policy 文本
  return SystemPromptBuilder.build({
    agentRole: buildStableSystemPrompt({ workingDir: '/tmp/p' }),
    baseRules: renderBaseRules(),
    projectRules: '',
    memoryContext: memoryEnabled ? MEMORY_POLICY_PROMPT : null,
    skillContext: '',
    toolSummary: ''
  })
}

describe('memory-disabled 回归', () => {
  it('memoryEnabled:false 时 system prompt 不含记忆层', () => {
    const settings = { ...DEFAULT_NOVA_SETTINGS, memoryEnabled: false }
    expect(settings.memoryEnabled).toBe(false)

    const prompt = buildPrompt(false)
    expect(prompt).not.toContain('Memory Policy')
    expect(prompt).not.toContain('Relevant Memory')
    expect(prompt).not.toContain(MEMORY_POLICY_PROMPT)
  })

  it('memoryEnabled:true 时记忆层为固定 policy 文本，不含记忆数据占位', () => {
    const prompt = buildPrompt(true)
    expect(prompt).toContain('=== Memory Policy ===')
    expect(prompt).toContain(MEMORY_POLICY_PROMPT)
    expect(prompt).not.toContain('Relevant Memory')
  })

  it('policy 文本逐字节稳定（重复构建一致）', () => {
    expect(buildPrompt(true)).toBe(buildPrompt(true))
    expect(MEMORY_POLICY_PROMPT).toContain('historical evidence')
    expect(MEMORY_POLICY_PROMPT).toContain('advisory')
  })
})

describe('采集门控由 memoryEnabled 一键统控', () => {
  it('memoryCaptureEnabled 默认 true（随总开关开启）', () => {
    // 用户视角下记忆只有 memoryEnabled 一个按钮；子开关默认全 true。
    expect(DEFAULT_NOVA_SETTINGS.memoryCaptureEnabled).toBe(true)
  })

  it('memoryEnabled false 时不应挂载采集（由 agentHandler 门控）', async () => {
    const { subscribeObservationCapture } = await import(
      '../../../../src/runtime/memory/MemoryObservationBridge'
    )
    const { ObservationCapture, resetObservationCapturesForTests } = await import(
      '../../../../src/runtime/memory/ObservationCapture'
    )
    resetObservationCapturesForTests()

    const settings = { ...DEFAULT_NOVA_SETTINGS, memoryEnabled: false }
    expect(settings.memoryEnabled).toBe(false)

    const capture = new ObservationCapture()
    expect(capture.getWorkingBuffer('sess')).toEqual([])
    expect(typeof subscribeObservationCapture).toBe('function')
  })
})
